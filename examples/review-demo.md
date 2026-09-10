# Review quantity validation

Status: completed · Runtime: Deterministic demo · no model calls · Attempt: 1

Repository: demo-repository
Base: 462b1cddce4de0506e4f36a75807c9f68149ef39
Head: baaaafd225c69ae0fad790244d6c716a10195b63
Context: 1ae91f1f93193a1253712a90

> Scripted demonstration. This is not an AI review.

## [high] Negative quantities pass validation

src/order.ts:4 (head) · supported

The new equality check rejects zero but accepts negative quantities. A request for −1 item reaches pricing and produces a negative order total. Keep rejecting quantities less than or equal to zero.

Scripted demo check: the changed condition accepts a negative quantity.

Evidence c3414230df72f519b677dded:

```
quantity === 0
```

## Context coverage

- Symbol and call relationships use deterministic static syntax analysis; dynamic dispatch and runtime behavior are not resolved.
- Virtual compilation applies NodeNext resolution and repository path aliases; other tsconfig compiler options are not applied.

Included excerpts: 9
Omitted: 0
Exploration bytes: 406
Input/output tokens: 0/0
Reported cost: unavailable

## Worker budgets

Tool-call ceiling: 40
Deadline: 600000ms
Context size: 98304 bytes
Tool calls used: 2
