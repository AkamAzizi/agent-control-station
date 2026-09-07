# Agent Control Station

Local TypeScript/pnpm control station for scoped coding-agent reviews. Daemon lives in `src/`; browser UI in `apps/web/`.

## Git authorship

Author every commit as the human operator only.

- Keep author and committer as `Akam Azizi` with the AkamAzizi GitHub noreply.
- Put only the intended subject and explanation in the message.
- Do not add `Co-authored-by`, `Made with Cursor`, Cursor links, or any AI/agent attribution trailer.
- After `git commit`, read `git log -1 --format=%B`. If a trailer was injected, rebuild that commit with `git commit-tree` (same tree and parent, cleaned message) and reset to it. Do not leave the trailer on the branch.

This repository keeps a `prepare-commit-msg` hook in `.githooks/` that strips Cursor trailers. Point git at it after clone:

```sh
git config core.hooksPath .githooks
```
