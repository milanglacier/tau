# Fix Project Name Truncated In The Left Panel

## Problem

The Tau web left sidebar displays the current project group as `scratch` when the real project directory is `~/Desktop/personal-projects/agent-scratch`.

The frontend only renders the last segment of `project.path`, which is reasonable when `project.path` is accurate. The bad value is produced by the backend while reconstructing project paths from Pi session storage directory names:

```ts
dir.name.replace(/^--/, '/').replace(/--$/, '').replace(/-/g, '/')
```

That decode treats every hyphen as a path separator. A storage directory representing `.../agent-scratch` is reconstructed as `.../agent/scratch`, so the sidebar's last-segment display becomes `scratch`.

## Root Cause

The session directory name is a lossy fallback encoding for display purposes. It cannot safely reconstruct real filesystem paths when a directory name itself contains hyphens.

The session JSONL header already carries the real cwd (`entry.cwd`). That is the canonical project path and should be used wherever Tau needs to show or match a project path.

## Fix Plan

1. Add a header-cwd reader for session JSONL files so APIs that do not parse the whole session can still use the canonical project path.
2. Update `/api/sessions` to group and return project paths using parsed session `cwd`.
3. Update `/api/projects` to match session counts/activity against the session header `cwd`, so hyphenated project directories under `--projects-dir` still show their history correctly.
4. Update `/api/search` to return the header `cwd` in each result's `project` field.
5. Add regression coverage for `agent-scratch` so the API returns the full hyphenated project path instead of a split path ending in `scratch`.

## Expected Outcome

For a session whose header says:

```json
{"type":"session","cwd":"/Users/northyear/Desktop/personal-projects/agent-scratch"}
```

the `/api/sessions` project path remains `/Users/northyear/Desktop/personal-projects/agent-scratch`, and the existing sidebar last-segment rendering displays `agent-scratch`.

Existing sessions without a usable header `cwd` keep their encoded `dirName` for file lookup, but Tau does not pretend the lossy storage directory name can recover a real project path.
