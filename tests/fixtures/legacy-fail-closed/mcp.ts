// Fail-closed guard; no simulated dispatch success. Integrate the qualified controller later.
export class ContinuumMCP {
  async handleToolCall(
    toolName: string,
    _params: unknown,
    _authContext: unknown,
  ) {
    if (toolName === 'execute_effect')
      return {
        status: 'NOT_ENABLED',
        reason:
          'Legacy effect execution disabled pending qualified controller migration',
      };
  }
}
