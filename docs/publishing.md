# Publishing this repository

This repository is published to GitHub through the **REST API**, not by
pushing. Two reasons:

- The host policy of the machine that maintains it denies `git push` and `gh`,
  so a push is not available as a publication path.
- A push hides what happened. An API publication writes one commit per file,
  which is exactly the history this repository does not want — so the
  publication tooling rebuilds the branch as a **single commit** that carries
  the local tree, and then proves the published tree matches.

Every command below is repo-resident and takes no secret material as an
argument.

## The commands

| Command | What it does | Writes? |
| --- | --- | --- |
| `npm run publish:check` | Compares the published tree with the local commit and reports the difference. | No |
| `npm run publish:tree` | Publishes the files that are missing or differ, one commit per file. | Yes |
| `npm run publish:rebuild` | Rebuilds the branch as one clean commit carrying the local tree, then verifies it. | Yes |

`publish:check` is the one to run first. It answers the question that
matters — *does the published repository match this commit* — without
changing the repository it measures.

### Rebuilding on a chosen commit

`publish:rebuild` parents the new commit on the **newest** published
ancestor whose tree is contained in the local tree, so the published history
grows one step at a time. To replace everything after a particular commit
instead — which is how an accidental publication is cleaned up — name the
base:

```sh
npm run publish:rebuild -- --base 9c1b5b5412f71f69e032ca7d1a211946763ce226
```

The base's own tree has to be contained in the local tree. If it carries a
path the local tree does not have, the command **refuses** rather than
publish a tree that lost content. `--message <text>` overrides the commit
message; without it, a commit built on a chosen base is named after the
release (`Release: <name> <version>`), because it replaces everything that
came after the base rather than adding one local change.

## How tree equality is proven

A git tree SHA covers every path, every mode and every byte beneath it. So
equality of the root tree SHA is not a summary of the comparison; it **is**
the comparison. The tooling does two things:

1. It reads the local tree with `git ls-tree -r HEAD` and the published tree
   with `GET /git/trees/{sha}?recursive=1`, and compares path by path,
   including the file mode.
2. It compares the root tree SHAs, so a file that changed its executable bit
   cannot pass.

The local and the published commit SHAs are **not** expected to match. GitHub
normalises commit timestamps to UTC and records the committer from the token,
so two commits with the same tree, the same message and the same parent get
different SHAs. The tree is the thing that can be compared.

## The workflow-file boundary

`.github/workflows/ci.yml` needs a permission no other file in this
repository needs:

- the `workflow` scope on a classic personal access token, or
- "Workflows: write" on a fine-grained token.

GitHub enforces that boundary in **two** places, and only one of them fails
loudly:

- the git data API accepts the blob, the tree and the commit — and then
  refuses every ref update that would introduce the file, with
  `404 Not Found`;
- a token without the permission is refused at the **blob** instead, also
  with `404 Not Found`, so the upload of the workflow file fails before any
  object is created.

Where the refusal lands depends on the token, so both are reported rather
than assumed. Measured on this repository:

| Token | New blob | Workflow blob | Ref update that introduces a workflow |
| --- | --- | --- | --- |
| classic PAT with `repo`, without `workflow` | 201 | 201 | **404** |
| classic PAT with no scopes | **404** | 404 | 404 |
| fine-grained PAT without "Workflows: write" | 201 | **404** | 404 |

The `x-oauth-scopes` header only describes a **classic** token. A
fine-grained token reports no scopes at all, and a classic token with no
scopes reports an empty header — so the header cannot tell the two apart.
The token's prefix can: `ghp_` is a classic token, `github_pat_` is a
fine-grained one, and `gho_` is an OAuth token such as the one
`gh auth login` stores.

`publish:rebuild` handles the boundary itself: it tries the complete tree
first, and when the move is refused it rebuilds the tree without the
workflow files and tries again. The report says which tree was published
and which file is missing.

Once the token carries the permission, one command publishes the file:

```sh
npm run publish:rebuild
```

## Where the token comes from

The publisher looks in three places, in this order, and prints which one it
used — never the token itself:

1. the `GITHUB_TOKEN` or `GITHUB_API_KEY` environment variable;
2. the repository's own `.env` file, for a `GITHUB_TOKEN` or `GITHUB_API_KEY`
   entry (the file is git-ignored, and only those two keys are read);
3. the git credential helper for `github.com`
   (`printf 'protocol=https\nhost=github.com\n\n' | git credential fill`).

**Every token is tried, not just the first.** A token is a permission set,
and the permissions differ between tokens: a token that can write ordinary
files may still be refused for a workflow file, and a token with no scopes
at all cannot write anything. Stopping at the first token would make the
outcome depend on which credential happened to be found first.

Neither the token, nor a request body, nor a credential ever reaches the
repository, the log, or the published tree.

## Re-aligning the local clone

The published branch and the local branch are two views of the same tree.
After a publication:

```sh
git fetch origin main
git reset --mixed origin/main   # the working tree is left alone
git status                       # shows what the publication still owes
```

`--mixed` never touches the working tree, so a file the published branch does
not carry yet stays on disk and shows up as untracked — which is the honest
report of what is missing rather than a silent deletion.
