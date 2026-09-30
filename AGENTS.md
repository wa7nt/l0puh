# Working on l0puh

Notes for whoever is editing this, human or not. The repo's own README covers what
the language is and where the project is going; this file covers how to change it.

## Commit freely

**Commit changes as you make them. Do not wait to be asked, and do not batch
them up at the end of a task.**

Every pushed branch gives GitHub something to show in the pull-request list, which
is how progress on this project stays visible. A commit per logical change is the
useful granularity; one commit covering a whole milestone is not.

## Branches and pull requests

Work on a branch named for what it does, not for the milestone number alone:

```
m15-guarded-inlining
m15b-type-inference
fix-phi-swap-copies
```

Push the branch, then open a pull request against `main`. A PR body should say
what changed, why, and — for anything that fixes a defect — what the symptom was
*before*. That last part is what makes a PR readable later: most real bugs in this
project produce a plausible wrong answer rather than a crash, so the symptom is
often the only thing that identifies them.

`main` is pushed to directly only for changes that are not real work: a version
bump, a README correction, a licence statement.

## Tests before committing

```
node --test "test/*.test.ts"
```

388 tests, no dependencies, about a minute. Committing a red suite is how a
baseline stops being a baseline. If a test genuinely cannot be made to pass, say
so in the commit message rather than dropping it from the run.

## Two rules that are easy to break by accident

**Never let the native backend and the interpreter disagree.** The interpreter is
the reference; the differential tests in `test/codegen.test.ts` run both and
compare. A disagreement is the signal that something is wrong, and it is usually a
wrong answer rather than a crash.

**Never add a type annotation or a type-checking pass to the surface language.**
Type information belongs in the IR, where the backend can use it to drop tag checks
and to narrow a value's storage. Putting it in the syntax would make every
existing program invalid and create obligations that are painful to withdraw. See
the roadmap in the README for the reasoning.

## Where the time actually goes

Two things dominate, and both were measured rather than assumed:

- **The call into C.** Every arithmetic operation was a function call, which is
  why `fib(32)` took 295 ms with roughly 28 million of them. Inlining the integer
  fast path behind a tag check is the single biggest available win, and it needs
  no type inference at all.
- **Stack traffic.** Every value occupied a 16-byte stack slot. Register
  allocation is the next step, but only after the calls are gone — inlining pays
  for itself several times over before registers matter.

## Numbers worth quoting carefully

`fib(32)`: interpreter ~7500 ms, native ~295 ms, on an i5-7360U. Past 2^53 the
interpreter stops being exact and the native backend is the correct one, so the two
genuinely disagree there. Quote these only with the machine named, and do not leave
them in files a later change will make stale without also refreshing the benchmark.
