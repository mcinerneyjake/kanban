import { describe, it, expect } from 'vitest';
import { agentRunId } from './provenance.js';

describe('agentRunId', () => {
  it('returns the runId when the ticket is a trusted agent write', () => {
    expect(agentRunId({ source: 'agent', runId: 'run-1' })).toBe('run-1');
  });
  it('returns null without the agent source stamp (a runId alone is not trusted)', () => {
    expect(agentRunId({ source: null, runId: 'run-1' })).toBeNull();
    expect(agentRunId({ source: undefined, runId: 'run-1' })).toBeNull();
  });
  it('returns null without a runId (nothing to deep-link to)', () => {
    expect(agentRunId({ source: 'agent', runId: null })).toBeNull();
    expect(agentRunId({ source: 'agent', runId: undefined })).toBeNull();
    expect(agentRunId({ source: 'agent', runId: '' })).toBeNull();
  });
});
