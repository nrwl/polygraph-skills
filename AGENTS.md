# Agent Guidelines for polygraph-skills

## OpenCode plugin — server.js export rule

Never add exports to `source/opencode/server.js`. OpenCode loads it as a plugin; any export beyond the plugin entry breaks OpenCode for every user with the plugin installed. Put shared or testable logic in sibling modules under `source/opencode/` and import it into `server.js`.
