# Choose direct tools and Code Mode by task shape

## Recommendation

Use direct MCP tools for short tasks where the model must inspect a result before it can choose the next action.

Use Code Mode for stages that have one or more of these features:

- large intermediate results that can be reduced before they reach the model
- long deterministic chains
- repeated calls followed by filtering or aggregation
- a tool catalog too large to put in the initial context

A small catalog can expose direct tools and `exec` together. Give the model short routing guidance and let it choose per stage. Keep direct tools available for semantic decisions, approvals, errors and native rich results.

The benchmark found no universal call-count threshold. Six independent small calls favoured direct tools. An 8-step chain and a 19-call list and fan-out stage favoured Code Mode.

## What we tested

We evaluated `@tmustier/code-mode-mcp@0.3.0` with native `anthropic/claude-opus-4-8:xhigh`.

The main benchmark used a deterministic 10-tool MCP server. It covered 8 task shapes and 4 conditions:

1. direct-only exposed all 10 tools
2. Code Mode-only exposed one `exec` tool
3. unguided hybrid exposed all 10 tools and `exec`
4. guided hybrid used the same surface with short routing guidance

Each condition ran each task 5 times. This produced 160 scored runs. Every run used the same prompt and exact JSON scorer for its task.

The direct MCP client could issue independent calls in parallel. This matters because Code Mode does not have an inherent parallelism advantage.

The tasks were:

| Task | Shape | Expected guided route |
|---|---|---|
| T1 | one lookup | direct |
| T2 | 6 independent small lookups | direct |
| T3 | 4 large datasets followed by a reduction | Code Mode |
| T4 | an 8-step dependent cursor chain | Code Mode |
| T5 | list 18 employees, fetch 18 records and aggregate them | Code Mode |
| T6 | semantic search, model selection and fetch | direct |
| T7 | a 2-step mechanical route and lookup | direct |
| T8 | one purpose-built canonical lookup | direct |

We fixed the expected hybrid route before running the hybrid conditions. We based it on the direct-only and Code Mode-only results.

## Guided hybrid selected the expected route

All 160 runs returned the exact expected answer.

The guided hybrid selected the expected route on its first attempt in 40 out of 40 runs. It made no redundant upstream calls. Every Code Mode stage completed in one `exec` cell without `search()` or `describe()`.

The unguided hybrid also returned 40 correct answers. It selected the expected route first in 37 runs and finished through that route in 35. Only 28 runs completed without route changes, discovery cells or redundant calls.

| Task | Unguided initial route | Unguided final lane | Guided route |
|---|---|---|---|
| T1 | direct 5 of 5 | direct 5 of 5 | direct 5 of 5 |
| T2 | direct 5 of 5 | direct 5 of 5 | direct 5 of 5 |
| T3 | Code Mode 4, direct 1 | Code Mode 2, direct 2, mixed 1 | Code Mode 5 of 5 |
| T4 | Code Mode 3, direct 2 | Code Mode 3, direct 2 | Code Mode 5 of 5 |
| T5 | Code Mode 5 of 5 | Code Mode 5 of 5 | Code Mode 5 of 5 |
| T6 | direct 5 of 5 | direct 5 of 5 | direct 5 of 5 |
| T7 | direct 5 of 5 | direct 5 of 5 | direct 5 of 5 |
| T8 | direct 5 of 5 | direct 5 of 5 | direct 5 of 5 |

The guidance explained 4 things:

- map each direct tool name to its exact nested Code Mode name
- choose the route for each stage, with direct tools as the default
- reuse a visible direct schema inside `exec` without discovering it again
- parse nested JSON from `result.content[0].text`, because `text()` selects output and does not parse a nested result

Unguided failures came from guessed nested names, incorrect result parsing and unnecessary verification calls. The guidance removed these failures in the scored runs.

## Direct tools and guided hybrid side by side

The guided hybrid used the direct lane for T1, T2, T6, T7 and T8. It used Code Mode for T3, T4 and T5.

| Task | Median wall time, direct | Median wall time, guided hybrid | Median prompt tokens, direct | Median prompt tokens, guided hybrid | Median cost, direct | Median cost, guided hybrid |
|---|---:|---:|---:|---:|---:|---:|
| T1 | 4.91s | 4.86s | 6,549 | 8,671 | $0.006314 | $0.006449 |
| T2 | 10.06s | 7.83s | 7,355 | 9,495 | $0.018476 | $0.019824 |
| T3 | 37.99s | 10.13s | 64,515 | 9,196 | $0.131571 | $0.017328 |
| T4 | 24.85s | 10.04s | 32,804 | 8,994 | $0.036302 | $0.014738 |
| T5 | 22.01s | 10.18s | 12,677 | 9,130 | $0.063116 | $0.016678 |
| T6 | 8.37s | 8.90s | 10,604 | 13,786 | $0.013705 | $0.014897 |
| T7 | 7.50s | 10.56s | 10,039 | 13,278 | $0.009942 | $0.013454 |
| T8 | 5.58s | 6.07s | 6,570 | 8,705 | $0.006625 | $0.008068 |

Across all 40 runs in each condition, the guided hybrid recorded:

- 40.6% less wall time than direct-only
- 46.2% less summed prompt processing
- 73.7% lower provider-reported cost
- 32.7% more initial context per run at the median

The aggregate gains came from T3, T4 and T5. On direct stages, the hybrid carried the extra `exec` schema and routing guidance without gaining a different execution path.

The T2 timing difference is sampling variation. Both conditions made the same 6 direct calls concurrently.

## Code Mode reduced payload and model turns

T3 fetched 4 datasets concurrently in both useful execution plans. Direct MCP then returned about 148,000 characters of raw records to the model. Code Mode reduced the records inside one cell and returned about 100 characters.

T4 had a dependency between every call. Direct MCP needed 8 model and tool cycles. Code Mode followed the chain inside one cell and returned the final values.

T5 reached 18-way upstream concurrency in both conditions. Direct MCP returned 18 result blocks to the model. Code Mode aggregated them inside one cell.

These results separate 3 concerns:

- catalog size controls how much schema enters the initial context
- task shape controls whether direct tools or Code Mode execute a stage efficiently
- upstream dependencies control available parallelism

## Direct tools remained better for short tasks

Direct tools were cheaper or similar for one-off lookups, semantic selection and a 2-step route. The guided hybrid used direct tools for these tasks.

The hybrid still paid an initial-context cost. Its median initial context was 4,328 tokens. Direct-only used 3,261 tokens and Code Mode-only used 2,484.

This difference is small at 10 tools. It will grow with the number and size of direct schemas. Hosts should use a direct hot set or deferred activation when catalogs grow.

## Large catalogs need progressive disclosure

A separate realistic benchmark tested larger catalogs. These results used one run per condition, so they show direction rather than a stable median.

At 77 direct tools:

- Code Mode used 2,700 initial context tokens
- direct exposure used 28,900 initial context tokens
- both completed the task
- Code Mode used 62% less summed prompt processing and cost 41% less
- Code Mode took 64% longer because it used more model turns for discovery

At 2,000 direct tools:

- Code Mode used 2,600 initial context tokens and completed the task
- direct exposure used 481,799 initial context tokens
- the direct run stopped for length before it called a tool
- Code Mode cost $0.136 and the failed direct run cost $3.011

Large catalogs therefore need progressive disclosure. This conclusion is separate from the route used to execute a selected stage.

## Cost varied with prompt caching

Provider-reported cost depended on cold and warm cache writes. The stable system and tool prefix was about 3,000 to 4,000 tokens and was not material to the main result.

Large direct tool results could extend the cached prefix by about 58,000 tokens. One direct T3 run wrote this extended prefix and cost $0.456. A later run read the same prefix and cost $0.126.

This was a new, longer cache entry. It did not replace the stable prefix.

The benchmark repeated deterministic data, which made cross-run cache hits more likely. Real tool results often change. We therefore treat call counts, model turns, payload size and prompt tokens as stronger evidence than the exact cost ratio.

Future cost tests should report cold-cache and warm-cache results separately.

## Product decision

A host should treat discovery and execution as separate choices.

For small catalogs:

- expose direct tools and `exec` together
- give the model short routing and nested-result guidance
- route each stage independently

For large catalogs:

- keep `exec` available from the start
- expose a small direct hot set
- activate more direct tools when the user or model needs native interaction

Keep writes, approvals, elicitations, errors and rich native artifacts direct by default. Use Code Mode for mechanical processing after the model has made the semantic choice.

Do not add a global mode switch or a universal tool-count rule. The benchmark supports a simple task-shape heuristic and per-stage routing.

## Tested routing guidance

The guided hybrid used this text. A host should generate the name mapping from its own direct-tool and nested-tool registries.

```text
Direct tools and exec can reach the same upstream service. Direct tool
small_eval_synthetic_<tool> corresponds inside exec to
tools.mcp__small_eval_synthetic__<tool>.

Default to direct tools, and issue independent direct calls together in one
turn. Use exec when the current stage is mechanical: intermediate results are
large and only need filtering or aggregation; many items must be processed into
a summary; or a long chain's later arguments follow deterministically from
earlier outputs. Stay direct when you must read a result to decide what to do
next, and for approvals, writes, elicitations or rich artifacts. You may switch
between surfaces at any turn.

If a needed schema is already visible as a direct tool, call that tool inside
one exec program without searching or describing it again. Nested calls return
an MCP CallToolResult. When a tool says it returns JSON text, parse
result.content[0].text with JSON.parse. text(...) is an output selector, not a
parser. Complete the mechanical stage in one cell, run independent calls
concurrently, and return enough summary data to verify the result without
re-fetching solely to check it.
```

## Limits

The main benchmark used one model, one synthetic 10-tool server and 5 repetitions. The exclusive and hybrid pairs ran at different times. Provider cache state therefore differed between some conditions.

The benchmark did not cover:

- approval-sensitive writes
- rich image or audio results
- cancellation and reconnect behaviour
- elicitation
- stateful OAuth workflows
- mixed tasks that change route more than once

These need separate tests before a host applies the routing guidance to every workflow.
