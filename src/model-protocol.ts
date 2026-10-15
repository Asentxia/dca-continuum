import type { ContextReference } from './context-service.js';
import {
  hasProtocolControls,
  validateContextReference,
  validProtocolUnicode,
} from './restricted-memory-protocol.js';

/** Defensive grammar/resource caps only, not model quality or runtime targets. */
export const LOCAL_MODEL_PROTOCOL =
  'continuum-local-model-protocol/v1' as const;
export const MODEL_PROTOCOL_CAPS = Object.freeze({
  wireBytes: 32 * 1024,
  proposalTextBytes: 4096,
  parserDepth: 4,
  parserNodes: 128,
});

export type ModelRequestBinding = Readonly<{
  protocol: typeof LOCAL_MODEL_PROTOCOL;
  invocationId: string;
  source: ContextReference;
}>;
export type ModelObservation =
  | Readonly<{ kind: 'OUTAGE' }>
  | Readonly<{
      kind: 'RESPONSE';
      terminal: 'END' | 'PARTIAL' | 'LIMIT';
      wire: Uint8Array;
    }>;
export type InertModelProposal = Readonly<{
  kind: 'UNVERIFIED_TEXT';
  text: string;
}>;
export type ModelClassification =
  | Readonly<{
      status: 'COMPLETE';
      semantic: 'UNVERIFIED_PROPOSAL';
      binding: ModelRequestBinding;
      proposal: InertModelProposal;
      authority: false;
      execution: 'NONE';
    }>
  | Readonly<{
      status: 'MALFORMED' | 'PARTIAL' | 'TRUNCATED' | 'OUTAGE' | 'FORGED_TOOL';
      reason: string;
      authority: false;
      execution: 'NONE';
    }>;

const typedArrayPrototype = Object.getPrototypeOf(Uint8Array.prototype);
const intrinsicArrayName = Object.getOwnPropertyDescriptor(
  typedArrayPrototype,
  Symbol.toStringTag,
)!.get!;
const intrinsicArrayBuffer = Object.getOwnPropertyDescriptor(
  typedArrayPrototype,
  'buffer',
)!.get!;
const intrinsicByteOffset = Object.getOwnPropertyDescriptor(
  typedArrayPrototype,
  'byteOffset',
)!.get!;
const intrinsicByteLength = Object.getOwnPropertyDescriptor(
  typedArrayPrototype,
  'byteLength',
)!.get!;

/**
 * Native byte view only; callers still apply their resource caps. Intrinsic
 * branding/getters avoid carrier accessors and reject proxy/non-byte views.
 * This is data validation, not containment of a compromised JavaScript runtime.
 */
export function modelWireView(value: unknown): Uint8Array | undefined {
  try {
    if (
      !ArrayBuffer.isView(value) ||
      intrinsicArrayName.call(value) !== 'Uint8Array'
    )
      return undefined;
    return new Uint8Array(
      intrinsicArrayBuffer.call(value),
      intrinsicByteOffset.call(value),
      intrinsicByteLength.call(value),
    );
  } catch {
    return undefined;
  }
}

const controlKeys = new Set([
  'tool',
  'tools',
  'tool_call',
  'tool_calls',
  'function',
  'function_call',
  'function_calls',
  'arguments',
  'action',
  'actions',
  'command',
  'commands',
  'execute',
  'approval',
  'approvals',
  'grant',
  'grants',
  'capability',
  'capabilities',
  'authority',
  'execution',
  'tenant',
  'principal',
  'provider',
  'route',
]);
const controlLabel =
  /(?:^|[^A-Za-z0-9_])["']?(?:tools?|tool_calls?|function(?:_calls?)?|arguments|actions?|commands?|execute|approvals?|grants?|capabilit(?:y|ies)|authority|execution|tenant|principal|provider|route)["']?\s*:/i;

function failure(
  status: Exclude<ModelClassification['status'], 'COMPLETE'>,
  reason: string,
): ModelClassification {
  // Never return raw wire, parsed fragments, or a salvaged proposal on failure.
  return Object.freeze({ status, reason, authority: false, execution: 'NONE' });
}

function exactRecord(value: unknown, keys?: readonly string[]) {
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    ![Object.prototype, null].includes(Object.getPrototypeOf(value))
  )
    return undefined;
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (
    Reflect.ownKeys(descriptors).some((key) => typeof key !== 'string') ||
    (keys !== undefined &&
      Object.keys(descriptors).sort().join(',') !==
        [...keys].sort().join(',')) ||
    Object.values(descriptors).some(
      (descriptor) => !('value' in descriptor) || !descriptor.enumerable,
    )
  )
    return undefined;
  return Object.fromEntries(
    Object.entries(descriptors).map(([key, descriptor]) => [
      key,
      descriptor.value,
    ]),
  ) as Record<string, unknown>;
}

export function validateModelBinding(value: unknown): ModelRequestBinding {
  const r = exactRecord(value, ['protocol', 'invocationId', 'source']);
  if (
    !r ||
    r.protocol !== LOCAL_MODEL_PROTOCOL ||
    typeof r.invocationId !== 'string' ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(
      r.invocationId,
    )
  )
    throw Error('model protocol binding');
  return Object.freeze({
    protocol: LOCAL_MODEL_PROTOCOL,
    invocationId: r.invocationId,
    source: validateContextReference(r.source),
  });
}

// Preserve number lexemes until their field grammar proves conversion lossless.
// JSON.parse of the entire object would lose duplicate keys and lexical forms.
class NumericToken {
  constructor(readonly lexeme: string) {}
}
type JsonValue =
  | null
  | boolean
  | string
  | NumericToken
  | JsonValue[]
  | { [key: string]: JsonValue };
class ParseFailure extends Error {
  constructor(readonly reason: 'JSON_SYNTAX' | 'JSON_BOUNDS' | 'UNICODE') {
    super(reason);
  }
}

class BoundedJsonParser {
  private offset = 0;
  private nodes = 0;
  constructor(private readonly text: string) {}

  parse(): JsonValue {
    const value = this.value(1);
    this.whitespace();
    if (this.offset !== this.text.length) throw new ParseFailure('JSON_SYNTAX');
    return value;
  }
  private whitespace() {
    while (/[ \t\r\n]/.test(this.text[this.offset] ?? '\0')) this.offset++;
  }
  private value(depth: number): JsonValue {
    if (
      depth > MODEL_PROTOCOL_CAPS.parserDepth ||
      ++this.nodes > MODEL_PROTOCOL_CAPS.parserNodes
    )
      throw new ParseFailure('JSON_BOUNDS');
    this.whitespace();
    const start = this.text[this.offset];
    if (start === '"') return this.string();
    if (start === '{') return this.object(depth);
    if (start === '[') return this.array(depth);
    for (const [word, value] of [
      ['true', true],
      ['false', false],
      ['null', null],
    ] as const) {
      if (this.text.startsWith(word, this.offset)) {
        this.offset += word.length;
        return value;
      }
    }
    const number = this.text
      .slice(this.offset)
      .match(/^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?/);
    if (!number) throw new ParseFailure('JSON_SYNTAX');
    this.offset += number[0].length;
    return new NumericToken(number[0]);
  }
  private string(): string {
    const start = this.offset++;
    while (this.offset < this.text.length) {
      const char = this.text[this.offset++];
      if (char === '"') {
        let decoded: unknown;
        try {
          // Native parsing is only for one string token, never an object.
          decoded = JSON.parse(this.text.slice(start, this.offset));
        } catch {
          throw new ParseFailure('JSON_SYNTAX');
        }
        if (typeof decoded !== 'string' || !validProtocolUnicode(decoded))
          throw new ParseFailure('UNICODE');
        return decoded;
      }
      if (char === '\\') this.offset++;
      else if (char.charCodeAt(0) < 0x20) throw new ParseFailure('JSON_SYNTAX');
    }
    throw new ParseFailure('JSON_SYNTAX');
  }
  private object(depth: number): JsonValue {
    const result: { [key: string]: JsonValue } = Object.create(null);
    const seen = new Set<string>();
    this.offset++;
    this.whitespace();
    if (this.text[this.offset] === '}') {
      this.offset++;
      return result;
    }
    while (true) {
      this.whitespace();
      if (this.text[this.offset] !== '"') throw new ParseFailure('JSON_SYNTAX');
      const key = this.string();
      if (seen.has(key)) throw new ParseFailure('JSON_SYNTAX');
      seen.add(key);
      this.whitespace();
      if (this.text[this.offset++] !== ':')
        throw new ParseFailure('JSON_SYNTAX');
      result[key] = this.value(depth + 1);
      this.whitespace();
      const delimiter = this.text[this.offset++];
      if (delimiter === '}') return result;
      if (delimiter !== ',') throw new ParseFailure('JSON_SYNTAX');
    }
  }
  private array(depth: number): JsonValue {
    const result: JsonValue[] = [];
    this.offset++;
    this.whitespace();
    if (this.text[this.offset] === ']') {
      this.offset++;
      return result;
    }
    while (true) {
      result.push(this.value(depth + 1));
      this.whitespace();
      const delimiter = this.text[this.offset++];
      if (delimiter === ']') return result;
      if (delimiter !== ',') throw new ParseFailure('JSON_SYNTAX');
    }
  }
}

function containsControlFields(value: JsonValue): boolean {
  if (!value || typeof value !== 'object' || value instanceof NumericToken)
    return false;
  if (Array.isArray(value)) return value.some(containsControlFields);
  return Object.entries(value).some(
    ([key, child]) =>
      controlKeys.has(key.toLowerCase()) || containsControlFields(child),
  );
}

function sourceReference(value: unknown): ContextReference | undefined {
  const r = exactRecord(value, ['id', 'version', 'digest']);
  if (!r || !(r.version instanceof NumericToken)) return undefined;
  const lexeme = r.version.lexeme;
  if (
    !/^[1-9][0-9]*$/.test(lexeme) ||
    lexeme.length > 10 ||
    (lexeme.length === 10 && lexeme > '2147483647')
  )
    return undefined;
  try {
    return validateContextReference({
      id: r.id,
      version: Number(lexeme),
      digest: r.digest,
    });
  } catch {
    return undefined;
  }
}

export function classifyModel(
  expected: ModelRequestBinding,
  observation: ModelObservation,
): ModelClassification {
  let binding: ModelRequestBinding;
  try {
    binding = validateModelBinding(expected);
  } catch {
    return failure('MALFORMED', 'EXPECTED_BINDING');
  }
  let o: ReturnType<typeof exactRecord>;
  try {
    const data = exactRecord(observation);
    o = data
      ? exactRecord(
          data,
          data.kind === 'OUTAGE' ? ['kind'] : ['kind', 'terminal', 'wire'],
        )
      : undefined;
  } catch {
    // Malformed observation reflection is a classification failure, not an
    // exception escape. This does not contain arbitrary JavaScript Proxy code.
    return failure('MALFORMED', 'OBSERVATION');
  }
  if (!o) return failure('MALFORMED', 'OBSERVATION');
  if (o.kind === 'OUTAGE') return failure('OUTAGE', 'TRANSPORT_OUTAGE');
  const wire = o.kind === 'RESPONSE' ? modelWireView(o.wire) : undefined;
  if (o.kind !== 'RESPONSE' || !wire)
    return failure('MALFORMED', 'OBSERVATION');
  // Partial/limit transport facts cannot be upgraded by body content; no decode,
  // parsing, salvaged prefix, fallback, retry, provider or executor call occurs.
  if (o.terminal === 'LIMIT') return failure('TRUNCATED', 'TRANSPORT_LIMIT');
  if (o.terminal === 'PARTIAL') return failure('PARTIAL', 'TRANSPORT_PARTIAL');
  if (o.terminal !== 'END') return failure('MALFORMED', 'OBSERVATION');
  if (wire.byteLength > MODEL_PROTOCOL_CAPS.wireBytes)
    return failure('MALFORMED', 'WIRE_BOUNDS');
  let parsed: JsonValue;
  try {
    if (wire[0] === 0xef && wire[1] === 0xbb && wire[2] === 0xbf)
      return failure('MALFORMED', 'BOM');
    const text = new TextDecoder('utf-8', {
      fatal: true,
      ignoreBOM: true,
    }).decode(wire);
    parsed = new BoundedJsonParser(text).parse();
  } catch (error) {
    return failure(
      'MALFORMED',
      error instanceof ParseFailure ? error.reason : 'UTF8',
    );
  }
  if (containsControlFields(parsed))
    return failure('FORGED_TOOL', 'CONTROL_FIELD');
  const r = exactRecord(parsed, [
    'protocol',
    'invocationId',
    'source',
    'completion',
    'proposal',
  ]);
  const reference = r ? sourceReference(r.source) : undefined;
  const proposal = r ? exactRecord(r.proposal, ['kind', 'text']) : undefined;
  if (
    !r ||
    !reference ||
    !proposal ||
    r.protocol !== binding.protocol ||
    r.invocationId !== binding.invocationId ||
    r.completion !== 'COMPLETE' ||
    reference.id !== binding.source.id ||
    reference.version !== binding.source.version ||
    reference.digest !== binding.source.digest ||
    proposal.kind !== 'UNVERIFIED_TEXT' ||
    typeof proposal.text !== 'string'
  )
    return failure('MALFORMED', 'SCHEMA_OR_BINDING');
  if (
    !proposal.text.trim() ||
    Buffer.byteLength(proposal.text, 'utf8') >
      MODEL_PROTOCOL_CAPS.proposalTextBytes
  )
    return failure('MALFORMED', 'PROPOSAL_BOUNDS');
  if (
    hasProtocolControls(proposal.text) ||
    /[{}\[\]<>`]/u.test(proposal.text) ||
    controlLabel.test(proposal.text)
  )
    return failure('FORGED_TOOL', 'CONTROL_TEXT');
  // This grammar is NOT semantic prompt-injection proof. Natural-language
  // instructions may remain inert untrusted text; nothing here executes them.
  return Object.freeze({
    status: 'COMPLETE',
    semantic: 'UNVERIFIED_PROPOSAL',
    binding,
    proposal: Object.freeze({
      kind: 'UNVERIFIED_TEXT',
      text: proposal.text,
    }),
    authority: false,
    execution: 'NONE',
  });
}
