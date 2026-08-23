import { execFile } from 'node:child_process';
import { z } from 'zod';
import { log } from '@/lib/log';
import { err, ok, type Result } from '@/lib/result';

const DEFAULT_TIMEOUT_MS = 20_000;
const DEFAULT_MAX_OUTPUT_BYTES = 2 * 1024 * 1024;

const idSchema = z.union([z.string(), z.number()]).transform(String);
const optionalMoneySchema = z
  .object({
    display_string: z.string().nullish(),
    unit_amount: z.number().nullish(),
  })
  .passthrough()
  .nullish();

const transportEnvelopeSchema = z
  .object({
    content: z.union([z.string(), z.array(z.unknown())]),
    isError: z.boolean(),
    structuredContent: z.unknown().optional(),
  })
  .passthrough();

const addressListSchema = z
  .object({
    addresses: z.array(
      z
        .object({
          id: idSchema.optional(),
          address_id: idSchema.optional(),
          address_link_id: idSchema.optional(),
          label: z.string().nullish(),
          address: z.string().nullish(),
          formatted_address: z.string().nullish(),
          printable_address: z.string().nullish(),
          street_address: z.string().nullish(),
          city: z.string().nullish(),
          state: z.string().nullish(),
          zip_code: z.string().nullish(),
          lat: z.number(),
          lng: z.number(),
          is_default: z.boolean().optional(),
        })
        .passthrough(),
    ),
  })
  .passthrough();

const restaurantSearchSchema = z
  .object({
    stores: z.array(
      z
        .object({
          store_id: idSchema,
          name: z.string(),
          description: z.string().nullish(),
          distance: z.union([z.string(), z.number()]).nullish(),
          delivery_time: z.union([z.string(), z.number()]).nullish(),
        })
        .passthrough(),
    ),
  })
  .passthrough();

const menuItemSchema = z
  .object({
    item_id: idSchema,
    name: z.string(),
    description: z.string().nullish(),
    price: z.union([z.number(), optionalMoneySchema]).nullish(),
    price_display_string: z.string().nullish(),
  })
  .passthrough();

const menuSchema = z
  .object({
    menu_id: idSchema,
    items: z.array(menuItemSchema),
  })
  .passthrough();

const cartListSchema = z
  .object({
    carts: z.array(
      z
        .object({
          cart_uuid: z.string(),
          store_id: idSchema.optional(),
          store_name: z.string().nullish(),
        })
        .passthrough(),
    ),
  })
  .passthrough();

const cartMutationSchema = z
  .object({
    success: z.boolean(),
    cart_uuid: z.string().optional(),
    cart: z
      .object({
        store_name: z.string().nullish(),
        group_cart_url: z.string().nullish(),
        items: z.array(z.unknown()).optional(),
      })
      .passthrough()
      .optional(),
    item_errors: z.array(z.unknown()).optional(),
  })
  .passthrough();

const orderPreviewSchema = z
  .object({
    success: z.boolean(),
    message: z.string().nullish(),
    quote: z
      .object({
        net_total_before_tip: optionalMoneySchema,
        line_items: z
          .array(
            z
              .object({
                label: z.string(),
                final_money: optionalMoneySchema,
              })
              .passthrough(),
          )
          .optional(),
        delivery_availability: z.unknown().optional(),
        dropoff_options: z.array(z.unknown()).optional(),
        expense_order_options: z.unknown().optional(),
        store_order_cart: z.unknown().optional(),
      })
      .passthrough()
      .optional(),
  })
  .passthrough();

export type DoorDashAddressList = z.infer<typeof addressListSchema>;
export type DoorDashRestaurantSearch = z.infer<typeof restaurantSearchSchema>;
export type DoorDashMenu = z.infer<typeof menuSchema>;
export type DoorDashCartList = z.infer<typeof cartListSchema>;
export type DoorDashCartMutation = z.infer<typeof cartMutationSchema>;
export type DoorDashOrderPreview = z.infer<typeof orderPreviewSchema>;

export type DoorDashCartItem = {
  itemId: string;
  itemName: string;
  quantity: number;
  nestedOptions?: Array<Record<string, unknown>>;
};

const CONTRACT_ERRORS = new Set([
  'dd_cli_invalid_json',
  'dd_cli_unexpected_envelope',
  'dd_cli_missing_structured_content',
  'dd_cli_unexpected_response',
]);

export const describeDdCliError = (error: string): string => {
  if (error === 'dd_cli_auth_required') {
    return 'DoorDash authentication is unavailable. Support code: DD-AUTH. Do not infer another cause.';
  }
  if (CONTRACT_ERRORS.has(error)) {
    return 'DoorDash returned an incompatible response. Support code: DD-CONTRACT. Do not infer another cause or blame the user’s request.';
  }
  if (error === 'dd_cli_timeout') {
    return 'DoorDash did not respond in time. Support code: DD-TIMEOUT. Do not infer another cause.';
  }
  if (error === 'dd_cli_output_too_large') {
    return 'DoorDash returned more data than Confetti can safely process. Support code: DD-OUTPUT. Do not infer another cause.';
  }
  if (error === 'dd_cli_command_error') {
    return 'DoorDash rejected the command without a safe diagnostic. Support code: DD-COMMAND. Do not infer another cause.';
  }
  return 'The DoorDash integration failed. Support code: DD-EXECUTOR. Do not infer another cause.';
};

export type DdCliCommandRunner = (
  args: readonly string[],
  options: { timeoutMs: number; maxOutputBytes: number },
) => Promise<Result<string, string>>;

export type DdCliClient = {
  listAddresses: (intent: string) => Promise<Result<DoorDashAddressList, string>>;
  searchRestaurants: (input: {
    query: string;
    lat: number;
    lng: number;
    limit?: number;
    intent: string;
  }) => Promise<Result<DoorDashRestaurantSearch, string>>;
  getMenu: (input: { storeId: string; intent: string }) => Promise<Result<DoorDashMenu, string>>;
  listCarts: (input: {
    storeId: string;
    intent: string;
  }) => Promise<Result<DoorDashCartList, string>>;
  addItems: (input: {
    storeId: string;
    menuId: string;
    items: DoorDashCartItem[];
    intent: string;
  }) => Promise<Result<DoorDashCartMutation, string>>;
  previewOrder: (input: {
    cartUuid: string;
    scheduledTime?: string;
    includeWorkBenefits: boolean;
    intent: string;
  }) => Promise<Result<DoorDashOrderPreview, string>>;
};

export const buildDoorDashIntent = (summary: string, rawPrompt: string): string =>
  `Summary: ${summary.trim()}\nuser prompt/purpose: ${JSON.stringify(rawPrompt.trim())}`;

export const createDdCliClient = (options?: {
  run?: DdCliCommandRunner;
  timeoutMs?: number;
  maxOutputBytes?: number;
}): DdCliClient => {
  const run = options?.run ?? runDdCli;
  const commandOptions = {
    timeoutMs: options?.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    maxOutputBytes: options?.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES,
  };

  const invoke = async <T>(
    args: readonly string[],
    schema: z.ZodType<T>,
  ): Promise<Result<T, string>> => {
    if (args.includes('submit') || args.includes('checkout-url')) {
      return err('unsafe_dd_cli_command_blocked');
    }
    const result = await run(['--json-output', ...args], commandOptions);
    if (!result.ok) return result;
    let value: unknown;
    try {
      value = JSON.parse(result.value);
    } catch {
      return err('dd_cli_invalid_json');
    }
    const envelope = transportEnvelopeSchema.safeParse(value);
    if (!envelope.success) {
      log.warn('dd-cli response envelope failed validation', {
        command: commandName(args),
        issuePath: firstIssuePath(envelope.error),
      });
      return err('dd_cli_unexpected_envelope');
    }
    if (envelope.data.isError) {
      const content = JSON.stringify(envelope.data.content);
      if (/login|sign.?in|token|credential|unauth/i.test(content)) {
        return err('dd_cli_auth_required');
      }
      return err('dd_cli_command_error');
    }
    if (envelope.data.structuredContent === undefined) {
      return err('dd_cli_missing_structured_content');
    }
    const parsed = schema.safeParse(envelope.data.structuredContent);
    if (!parsed.success) {
      log.warn('dd-cli structured content failed validation', {
        command: commandName(args),
        issuePath: firstIssuePath(parsed.error),
      });
      return err('dd_cli_unexpected_response');
    }
    return ok(parsed.data);
  };

  return {
    listAddresses: (intent) => invoke(['address', 'list', '--intent', intent], addressListSchema),
    searchRestaurants: ({ query, lat, lng, limit = 5, intent }) =>
      invoke(
        [
          'search',
          '--query',
          query,
          '--lat',
          String(lat),
          '--lng',
          String(lng),
          '--limit',
          String(limit),
          '--intent',
          intent,
        ],
        restaurantSearchSchema,
      ),
    getMenu: ({ storeId, intent }) =>
      invoke(['menu', '--store-id', storeId, '--intent', intent], menuSchema),
    listCarts: ({ storeId, intent }) =>
      invoke(['cart', 'list', '--store-id', storeId, '--intent', intent], cartListSchema),
    addItems: ({ storeId, menuId, items, intent }) =>
      invoke(
        [
          'cart',
          'add-items',
          '--store-id',
          storeId,
          '--menu-id',
          menuId,
          '--items-json',
          JSON.stringify(
            items.map((item) => ({
              item_id: item.itemId,
              item_name: item.itemName,
              quantity: item.quantity,
              ...(item.nestedOptions ? { nested_options: item.nestedOptions } : {}),
            })),
          ),
          '--fulfillment',
          'delivery',
          '--intent',
          intent,
        ],
        cartMutationSchema,
      ),
    previewOrder: ({ cartUuid, scheduledTime, includeWorkBenefits, intent }) =>
      invoke(
        [
          'order',
          'preview',
          '--cart-uuid',
          cartUuid,
          ...(scheduledTime ? ['--scheduled-time', scheduledTime] : []),
          ...(includeWorkBenefits ? ['--include-work-benefits'] : []),
          '--intent',
          intent,
        ],
        orderPreviewSchema,
      ),
  };
};

const commandName = (args: readonly string[]): string => {
  const commandArgs = args.filter((arg) => arg !== '--json-output');
  const [group, subcommand] = commandArgs;
  if (group === 'address' || group === 'cart' || group === 'order') {
    return [group, subcommand].filter(Boolean).join(' ');
  }
  return group ?? 'unknown';
};

const firstIssuePath = (error: z.ZodError): string =>
  error.issues[0]?.path.map(String).join('.') || '<root>';

const runDdCli: DdCliCommandRunner = (args, options) =>
  new Promise((resolve) => {
    const startedAt = Date.now();
    execFile(
      'dd-cli',
      [...args],
      {
        timeout: options.timeoutMs,
        maxBuffer: options.maxOutputBytes,
        encoding: 'utf8',
        shell: false,
      },
      (error, stdout, stderr) => {
        if (!error) {
          log.info('dd-cli command completed', {
            command: commandName(args),
            durationMs: Date.now() - startedAt,
            exitCode: 0,
          });
          resolve(ok(stdout));
          return;
        }
        const detail = stderr.trim().slice(0, 500);
        const exitCode =
          'code' in error && (typeof error.code === 'number' || typeof error.code === 'string')
            ? error.code
            : null;
        let errorCode = 'dd_cli_failed';
        if ('killed' in error && error.killed) {
          errorCode = 'dd_cli_timeout';
        } else if (/maxbuffer/i.test(error.message)) {
          errorCode = 'dd_cli_output_too_large';
        } else if (/login|sign.?in|token|credential/i.test(`${error.message}\n${detail}`)) {
          errorCode = 'dd_cli_auth_required';
        }
        log.warn('dd-cli command failed', {
          command: commandName(args),
          durationMs: Date.now() - startedAt,
          exitCode,
          errorCode,
        });
        resolve(err(errorCode));
      },
    );
  });
