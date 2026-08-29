# dd-cli v0.2.3 contract fixtures

These fixtures preserve the transport and command-payload shapes used by Confetti without retaining
real DoorDash account data. Names, addresses, coordinates, identifiers, prices, messages, and cart
UUIDs are synthetic. The root envelope and payload field names match inspected v0.2.3 output.

When the pinned dd-cli version changes:

1. Use a dedicated test DoorDash account.
2. capture `--json-output` for each command represented in this directory, including
   `restaurant-item-details` and a `cart add-items` required-options failure;
3. replace every personal, location, store, item, cart, price, and account value with an obviously
   synthetic value while preserving types, field names, nesting, optional fields, and nullability;
4. remove tokens, cookies, headers, URLs containing credentials, and unneeded free-form text;
5. review the sanitized diff manually;
6. run `pnpm test -- tests/dd-cli-client.test.ts`, `pnpm check`, and
   `pnpm exec tsc --noEmit`; and
7. update the pinned-version documentation only after the contract tests pass.

Never commit raw CLI output, even temporarily.
