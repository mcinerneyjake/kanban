import { describe, it, expect } from 'vitest';
import { ticketProvenance } from './provenance.js';

describe('ticketProvenance', () => {
  it('returns source+runId for a trusted agent write', () => {
    expect(ticketProvenance({ source: 'agent', runId: 'run-1' })).toEqual({ source: 'agent', runId: 'run-1' });
  });
  it('returns source+runId for an assisted (in-app draft) write', () => {
    expect(ticketProvenance({ source: 'assisted', runId: 'run-2' })).toEqual({ source: 'assisted', runId: 'run-2' });
  });
  it('returns null without a source stamp (a runId alone is not trusted)', () => {
    expect(ticketProvenance({ source: null, runId: 'run-1' })).toBeNull();
    expect(ticketProvenance({ source: undefined, runId: 'run-1' })).toBeNull();
  });
  it('returns null without a runId (nothing to deep-link to)', () => {
    expect(ticketProvenance({ source: 'agent', runId: null })).toBeNull();
    expect(ticketProvenance({ source: 'assisted', runId: undefined })).toBeNull();
    expect(ticketProvenance({ source: 'agent', runId: '' })).toBeNull();
  });
});
