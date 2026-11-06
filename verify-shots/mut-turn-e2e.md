# Multi-user threads turn E2E (0.2.7)

- **ok**: true
- **version**: 0.2.7
- **deployId**: 7c460b50-ff16-4ec8-a036-9337e1f1e65c
- **base**: https://mastra-l1.summersmile1984.workers.dev
- **at**: 2026-11-03T04:30:04.584Z (UTC)

## Sample turn (excerpt)

```
<turn author_id="k6zxp3CyDPCLmwW8AOcggfGfccVd1C8X" author_name="spa-shot-1793614103@example.com" functional_role="owner" room="5dfd33b5-1bc1-41e7-8005-c6f084cd194e">
MUT-turn-proof 1793680214204 请简短确认你能读到我的 author_name
</turn>
```

## Proofs

```json
{
  "health": {
    "status": 200,
    "version": "0.2.7"
  },
  "me": {
    "uid": "k6zxp3CyDPCLmwW8AOcggfGfccVd1C8X",
    "email": "spa-shot-1793614103@example.com"
  },
  "createRoom": {
    "status": 201,
    "id": "5dfd33b5-1bc1-41e7-8005-c6f084cd194e",
    "role": "owner"
  },
  "postMessage": {
    "status": 200,
    "replies": [
      {
        "agentId": "orchestrator",
        "reply": "能读到，author_name 是 spa-shot-1793614103@example.com。"
      }
    ]
  },
  "getMessages": {
    "status": 200,
    "count": 2,
    "userCount": 1,
    "hasAuthorId": true,
    "hasFunctionalRole": true,
    "hasAuthorName": true,
    "hasOldFromUserOnly": false,
    "excerpt": "<turn author_id=\"k6zxp3CyDPCLmwW8AOcggfGfccVd1C8X\" author_name=\"spa-shot-1793614103@example.com\" functional_role=\"owner\" room=\"5dfd33b5-1bc1-41e7-8005-c6f084cd194e\">\nMUT-turn-proof 1793680214204 请简短确认你能读到我的 author_name\n</turn>"
  },
  "wmProbe": {
    "dmStatus": 200,
    "hasWorking": true,
    "note": "DM WM endpoint; room WM is resource room:{id} (server-side refresh)"
  },
  "functionalRoleValue": "owner",
  "uiNav": "hash",
  "roomId": "5dfd33b5-1bc1-41e7-8005-c6f084cd194e",
  "thread": "room_5dfd33b5-1bc1-41e7-8005-c6f084cd194e",
  "uid": "k6zxp3CyDPCLmwW8AOcggfGfccVd1C8X",
  "chromeOk": true
}
```

## Room WM (D1)

```
# Room Collaboration State

## Participants
- **spa-shot-1793614103@example.com** (k6zxp3CyDPCLmwW8AOcggfGfccVd1C8X, owner)
```

## Thin spots

- SPA room deep-link via hash may not open the exact room UI (screenshots are app shell); parent can re-shot room chat if needed.
- Room WM is server-refreshed participants list only (no OM); agent generate stays readOnly — agent cannot mutate room WM.

## Shots

- /workspace/shots/mut-turn-1-app.png
- /workspace/shots/mut-turn-2-room.png

## Asserts

- New room messages include `author_id=` and `functional_role=` (not only legacy `from_user`).
- Speaker identity set server-side from Better Auth + `room_members.role`.
- Room generate remains `readOnly: true`; participants WM refreshed server-side (D1 has no OM).
