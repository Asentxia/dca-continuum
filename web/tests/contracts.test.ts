import { describe, it, expect } from 'vitest';
import {
  ItemSchema,
  OperationStateSchema,
  CommandReceiptSchema,
} from '@continuum/contracts';
const fields = {
  operation: 'operation-one',
  effectState: 'REQUESTED',
  digest: 'a'.repeat(64),
  principal: 'vera-one',
  action: 'write',
  resource: 'fixture-object',
  parameters: { value: 'exact' },
  canonicalBinding: { id: 'operation-one' },
  grant: 'grant-one',
  grantVersion: 1,
  principalEpoch: 1,
  principalGeneration: 1,
  placementGeneration: 1,
  deadline: '2026-10-09T00:00:00Z',
  verificationMethod: 'Matching fixture read-back',
  approvalRevision: 0,
};
const item = {
  id: 'operation-one',
  kind: 'operation',
  title: 'Exact immutable action',
  version: 1,
  status: 'Pending exact review',
  fields,
};
describe('versioned shared runtime contracts', () => {
  it('Accepts exactly the seven domain operation wire states', () => {
    for (const value of [
      'REQUESTED',
      'RESERVED',
      'SENDING',
      'COMMITTED',
      'UNKNOWN',
      'DENIED',
      'FAILED_KNOWN_NO_EFFECT',
    ])
      expect(OperationStateSchema.parse(value)).toBe(value);
    expect(() => OperationStateSchema.parse('SUCCEEDED')).toThrow();
  });
  it('Unknown operation enum or incomplete exact preview fails closed', () => {
    expect(ItemSchema.parse(item).id).toBe('operation-one');
    expect(() =>
      ItemSchema.parse({
        ...item,
        fields: { ...fields, effectState: 'SUCCEEDED' },
      }),
    ).toThrow();
    const { canonicalBinding, ...missing } = fields;
    expect(() => ItemSchema.parse({ ...item, fields: missing })).toThrow();
  });
  it('A purported permission receipt cannot assert a consequential external effect', () => {
    expect(() =>
      CommandReceiptSchema.parse({
        schema_version: 1,
        command_id: 'b0c3a8b2-8e41-4313-b00c-bfcf0535d599',
        idempotency_key: 'one',
        status: 'APPLIED',
        result_ref: 'b0c3a8b2-8e41-4313-b00c-bfcf0535d599',
        result: {},
        error_code: null,
        reused: false,
        external_effect: true,
      }),
    ).toThrow();
  });
});
