import { describe, expect, it } from 'vitest';
import { describeFailure } from '../../src/main/environments/failures';
import { splitDetails } from '../../src/shared/errors';

const failed = (command: string, stderr: string, exitCode = 128) => splitDetails(describeFailure(command, { path: `/usr/bin/${command}`, exitCode, stdout: '', stderr }));

describe('why git or a Forge CLI failed, in a sentence', () => {
  it.each([
    ['git', 'fatal: not a git repository (or any of the parent directories): .git', "it isn't in a git repository"],
    ['git', "fatal: a branch named 'loom/fix-it' already exists", 'there\'s already a branch named "loom/fix-it"'],
    ['git', "fatal: 'main' is already checked out at '/home/dev/billing-api'", '"main" is already checked out in /home/dev/billing-api'],
    ['git', "fatal: 'main' is already used by worktree at '/home/dev/billing-api'", '"main" is already checked out in /home/dev/billing-api'],
    ['git', "fatal: '/home/dev/worktrees/fix-it' already exists", "there's already a folder at /home/dev/worktrees/fix-it"],
    ['git', 'fatal: invalid reference: origin/nope', 'there\'s no branch or commit "origin/nope"'],
    ['git', "fatal: ambiguous argument 'nope': unknown revision or path not in the working tree.\nUse '--' to separate paths from revisions", 'there\'s no branch or commit "nope"'],
    ['git', "fatal: Not a valid object name: 'nope'.", 'there\'s no branch or commit "nope"'],
    ['git', "fatal: Unable to create '/home/dev/billing-api/.git/index.lock': File exists.\n\nAnother git process seems to be running in this repository", 'another git command is running there, or one stopped and left /home/dev/billing-api/.git/index.lock behind; wait for it, or delete that file'],
    ['git', "fatal: '/srv/gone.git' does not appear to be a git repository\nfatal: Could not read from remote repository.", "the repository wasn't found, or you don't have access to it"],
    ['git', "fatal: unable to access 'https://github.com/a/b.git/': Could not resolve host: github.com", "couldn't reach github.com: check your network connection"],
    ['git', "ssh: Could not resolve hostname gitlab.example.org: Name or service not known\nfatal: Could not read from remote repository.", "couldn't reach gitlab.example.org: check your network connection"],
    ['git', 'git@github.com: Permission denied (publickey).\nfatal: Could not read from remote repository.', 'the server refused your SSH key'],
    ['git', "fatal: could not read Username for 'https://github.com': terminal prompts disabled", "the server didn't accept your credentials"],
    ['git', "fatal: '/home/dev/worktrees/fix-it' contains modified or untracked files, use --force to delete it", 'it has changes that would be lost'],
    ['gh', 'To get started with GitHub CLI, please run:  gh auth login', "gh isn't signed in: run `gh auth login`"],
    ['glab', 'ERROR: 401 Unauthorized', "glab isn't signed in: run `glab auth login`"],
    ['gh', 'GraphQL: Could not resolve to a PullRequest with the number of 99. (repository.pullRequest)', "there's no such pull request"],
    ['gh', 'gh: Not Found (HTTP 404)', "it wasn't found, or you don't have access to it"],
    ['gh', 'API rate limit exceeded for user ID 1. (HTTP 403)', 'the Forge API rate limit is used up: try again in a while'],
  ])('%s: %s', (command, stderr, sentence) => {
    expect(failed(command, stderr)).toEqual({ message: sentence, details: stderr });
  });

  it("gives the first line of a message it doesn't know, without the tool's prefix, and all of it as Details", () => {
    const stderr = 'GraphQL: Head branch was modified. Review and try the merge again. (mergePullRequest)';
    expect(failed('gh', stderr, 1)).toEqual({ message: 'Head branch was modified. Review and try the merge again', details: stderr });
    expect(failed('git', 'fatal: something new\nhint: and a hint')).toEqual({ message: 'something new', details: 'fatal: something new\nhint: and a hint' });
  });

  it('says only the exit code when nothing was printed', () => {
    expect(failed('git', '', 1)).toEqual({ message: 'git exited with code 1' });
  });
});
