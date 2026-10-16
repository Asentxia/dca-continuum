import {
  MODEL_PROTOCOL_CAPS,
  modelWireView,
  validateModelBinding,
  type ModelObservation,
  type ModelRequestBinding,
} from '../../src/model-protocol.js';
import { assertLocalFixtures } from '../../src/runtime-profile.js';

function snapshot(observation: ModelObservation): ModelObservation {
  if (
    !observation ||
    typeof observation !== 'object' ||
    ![Object.prototype, null].includes(Object.getPrototypeOf(observation))
  )
    throw Error('local model observation');
  const descriptors = Object.getOwnPropertyDescriptors(observation);
  if (
    Reflect.ownKeys(descriptors).some((key) => typeof key !== 'string') ||
    Object.values(descriptors).some(
      (descriptor) => !('value' in descriptor) || !descriptor.enumerable,
    )
  )
    throw Error('local model observation');
  const data = Object.fromEntries(
    Object.entries(descriptors).map(([key, descriptor]) => [
      key,
      descriptor.value,
    ]),
  );
  if (data.kind === 'OUTAGE') {
    if (Object.keys(data).sort().join(',') !== 'kind')
      throw Error('local model observation');
    return Object.freeze({ kind: 'OUTAGE' });
  }
  const source = modelWireView(data.wire);
  if (
    data.kind !== 'RESPONSE' ||
    Object.keys(data).sort().join(',') !== 'kind,terminal,wire' ||
    !['END', 'PARTIAL', 'LIMIT'].includes(data.terminal) ||
    !source ||
    source.byteLength > MODEL_PROTOCOL_CAPS.wireBytes
  )
    throw Error('local model observation bounds');
  const wire = new Uint8Array(source.byteLength);
  wire.set(source);
  return Object.freeze({
    kind: 'RESPONSE',
    terminal: data.terminal,
    wire,
  });
}

/**
 * Explicit scripted local observations only. Not a model gateway, executor,
 * provider selector, source reader, credential store, or fallback implementation.
 */
export class LocalModelProtocolDouble {
  private script: ModelObservation;
  private count = 0;
  constructor(observation: ModelObservation) {
    assertLocalFixtures('local model protocol double');
    this.script = snapshot(observation);
  }
  get observations(): number {
    assertLocalFixtures('local model protocol double');
    return this.count;
  }
  async observe(binding: ModelRequestBinding): Promise<ModelObservation> {
    assertLocalFixtures('local model protocol double');
    validateModelBinding(binding);
    this.count++;
    return snapshot(this.script);
  }
  setObservation(observation: ModelObservation): void {
    assertLocalFixtures('local model protocol double');
    this.script = snapshot(observation);
  }
  reset(): void {
    assertLocalFixtures('local model protocol double');
    this.script = Object.freeze({ kind: 'OUTAGE' });
  }
}
