# Codex

- Built-in name: `codex`
- Default command: `npx -y @agentclientprotocol/codex-acp`
- Upstream: https://github.com/agentclientprotocol/codex-acp
- ACPX owns the built-in package range so fresh launches use the repository-selected stable adapter line without requiring a global install.
- Runtime controls exposed by current codex-acp releases include ACP modes plus separate `model` and `reasoning_effort` session config options.
- Prefer `acpx --model <id> --effort <level> codex ...`. ACPX applies the model first and validates the effort against the refreshed `reasoning_effort` values advertised for that model.
- For an existing session, `acpx codex set model <id>` and `acpx codex set reasoning_effort <value>` remain available; direct effort changes update the same persisted preference as `--effort`.
- Effort values are model-specific and come from codex-acp. ACPX does not hard-code a catalog or synthesize combined bracket ids. A legacy combined model id is used only when an older adapter explicitly advertises it as a model value.

```bash
acpx --model gpt-5.6-sol --effort high codex 'review the changed files'
acpx --model gpt-5.6-sol --effort max codex exec 'analyze this repository'
```
