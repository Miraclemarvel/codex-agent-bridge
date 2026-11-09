---
name: agent-bridge-setup
description: Check a newly installed Agent Bridge plugin and show how to delegate to configured Hermes and DeepSeek Harness agents from Codex.
---

Use the plugin tools to check the installed connection. Call `agents_list` and `agent_get_config` for the configured Agent IDs. The plugin starts or reuses a shared local coordinator; no manual terminal startup is needed for normal use.

Report which agents are reachable and their configured provider/model. A successful capability probe is not proof of model authentication. Do not change model defaults or submit inference tasks merely to finish setup. If the user requests configuration, call `dashboard_open` and open its returned URL through the host browser capability.

Explain that normal requests can name Hermes or DeepSeek Harness, describe the deliverable and acceptance criteria, and ask Codex to track and review the outcome. The `agent-collaboration` skill governs that workflow. Configuration and task history belong to the shared coordinator and survive individual Codex chats closing.
