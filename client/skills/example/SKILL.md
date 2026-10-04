---
name: example
description: How to write good git commit messages (imperative subject, conventional-commit style, attribution). Use when the user asks you to commit or format a commit message.
---

This is the body of the example skill. It is loaded only when the agent calls
`invoke_skill` with name `example` — its description in the system prompt is
what the model reads to decide whether to use it.

When writing or reviewing a commit message:

1. Keep the subject imperative and under 50 characters (e.g. `client: add
   local skill support`, not "Added local skill support").
2. Prefix the scope: `<area>: <summary>`, matching the repo's areas (`server`,
   `client`, `docs`, …). One logical change per commit.
3. In the body (only if needed), explain the *why*, not just the *what*;
   imperative mood, wrapped at 72 columns.
4. Always end AI-assisted commits with the attribution line — see the bundled
   reference.

The bundled file `references/conventions.md` (same directory as this
SKILL.md) has the full conventions and worked examples — read it before
writing a commit.

The bundled `scripts/format.sh` clamps a commit subject line to 50 characters
(policy #2). Use it to check a candidate subject before committing:

    run_skill_script skill: `example`, script: `format.sh`, args: ["<subject>"]
    slask-client skill run example format.sh <subject>
