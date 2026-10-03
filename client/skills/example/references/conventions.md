Commit-message conventions for slask-mcp:

Subject line
- Imperative mood, no trailing period: `client: add local skill support`,
  not "Added local skill support".
- Under 50 characters: a scope prefix `<area>:` followed by a short summary.
  Common areas: `server`, `client`, `docs`.
- One logical change per commit.

Body (optional — only when the subject isn't self-explanatory)
- Imperative mood ("explain", "add", "fix"), not present tense.
- Explain why the change was made, not just what it does.
- Wrap at 72 columns.

Trailing footer
- AI-assisted commits end with:

    Co-Authored-By: Claude Code <noreply@anthropic.com>

Examples

Good:

    client: add local skill support

    Discover skills from ./skills/ and expose a lazy invoke_skill tool so
    the agent can reach them without bloating context.

    Co-Authored-By: Claude Code <noreply@anthropic.com>

Bad:

    Added skills and a new tool because the model needed them

(no scope, declarative mood, no rationale)
