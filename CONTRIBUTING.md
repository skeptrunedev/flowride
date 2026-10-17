# Contributing

Small, focused improvements are welcome. Open an issue with the expected behavior and a reproducible example, or submit a pull request explaining the problem, the change and how it was checked.

## Development

Use Node 24 and run `npm ci`, then `npm run dev`. Before submitting:

```sh
npm run format
npm test
npm run build
```

Keep navigation calculations in `src/navigation.js` and asynchronous recovery in `src/rerouting.js`. Add deterministic tests when changing matching, progress, turn advancement or rerouting. Use the demo and its missed-turn control to check the phone experience without granting GPS permission.

## Navigation invariants

- Intermediate points must never require arrival confirmation.
- Unreliable GPS must not advance route progress or trigger recovery.
- Recovery must retain the unvisited scenic points and original route tail.
- Stopping a ride must invalidate pending routing responses.
- API failures must preserve the current route and avoid request loops.

Describe simulated checks separately from real-device or on-road tests. Never commit credentials, personal GPS traces or route links containing someone else's location. Contributions are provided under the repository's MIT license; retain third-party notices and map attribution.
