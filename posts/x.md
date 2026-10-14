Your agent says it addressed the review comments. Here is how you find out if it actually did.

I built agent-review-loop on top of slashdocs: humans leave anchored comments (pinned to the exact words), the agent pushes v2, and a harness re-derives every verdict from the character-level diff — never from the model's word.

Five numbers, no vibes:
• Attribution rate — did the anchored text actually change?
• Collateral churn — what % of edits happened OUTSIDE every anchor? (rewrote the doc and hoped nobody noticed)
• Claim accuracy — agent's report vs the diff
• Tokens per attributed fix
• Rounds to converge

It caught a model claiming all 4 comments fixed while pushing zero changes:
"VERIFICATION: MODEL CLAIMED ADDRESSED - ANCHORED TEXT UNCHANGED" ×4

Same doc + same comments, two models → two different scorecards. That's what measuring looks like.

github.com/harishkotra/agent-review-loop
