import { quoteTotalCents } from '@/agent/doordash-execution-types';
import type { Db } from '@/db/client';
import {
  getOrCreateDoorDashExecution,
  listOwnedDoorDashCartUuids,
  updateDoorDashExecution,
} from '@/db/queries/doordash-executions';
import { formatCartItemErrors } from '@/integrations/doordash/cart-item-errors';
import type { DdCliClient, DoorDashCartMutation } from '@/integrations/doordash/dd-cli-client';
import { matchSavedAddress, savedAddressId } from '@/integrations/doordash/resolve-address';
import { log } from '@/lib/log';
export type DoorDashPreviewOutcome =
  | { ok: true; value: Record<string, unknown> }
  | { ok: false; error: string; retry: boolean; detail: string };

type PreviewInput = {
  db: Db;
  doorDash: DdCliClient;
  workspaceId: string;
  actionId: string;
  storeId: string;
  restaurant: string;
  menuId: string;
  items: Array<{
    itemId: string;
    itemName: string;
    quantity: number;
    nestedOptions?: Record<string, unknown>[];
  }>;
  deliveryAt?: string;
  deliveryAddress: string;
  placeId?: string;
  addressId?: string;
  approvedMaxCents: number;
  intent: string;
};

export const executeDoorDashPreview = async (
  input: PreviewInput,
): Promise<DoorDashPreviewOutcome> => {
  let execution = await getOrCreateDoorDashExecution(input.db, {
    workspaceId: input.workspaceId,
    actionId: input.actionId,
    storeId: input.storeId,
    approvedMaxCents: input.approvedMaxCents,
  });
  if (execution.status === 'completed' && execution.quote) {
    return okPreview(execution.cartUuid, input, execution.quote);
  }
  if (execution.status === 'recovered') {
    return {
      ok: false,
      error: 'doordash_preview_already_recovered',
      retry: false,
      detail: 'This preview was already marked recovered. No order was submitted.',
    };
  }
  if (!execution.cartUuid) {
    const synced = await syncApprovedDeliveryAddress(input);
    if (!synced.ok) return synced;
  }

  const listed = await input.doorDash.listCarts({
    storeId: input.storeId,
    intent: input.intent,
  });
  if (!listed.ok) {
    return retryable(`doordash_cart_lookup_failed:${listed.error}`, execution.errorCode);
  }
  const listedUuids = listed.value.carts.map((cart) => cart.cart_uuid);
  if (execution.checkpoint === 'started') {
    const saved = await updateDoorDashExecution(input.db, {
      executionId: execution.id,
      workspaceId: input.workspaceId,
      checkpoint: 'listed_carts',
      listedCartUuids: listedUuids,
    });
    if (saved) execution = saved;
  }

  const ownedCartUuids = await listOwnedDoorDashCartUuids(
    input.db,
    input.workspaceId,
    input.storeId,
  );
  let shouldAddItems = false;
  if (!execution.cartUuid) {
    const created = adoptOrCreateCart(
      execution.listedCartUuids,
      listedUuids,
      execution.checkpoint,
      ownedCartUuids,
    );
    if (created.kind === 'existing_user_cart') {
      await updateDoorDashExecution(input.db, {
        executionId: execution.id,
        workspaceId: input.workspaceId,
        status: 'needs_review',
        errorCode: 'doordash_existing_cart_requires_review',
      });
      return {
        ok: false,
        error: 'doordash_existing_cart_requires_review',
        retry: false,
        detail:
          'DoorDash already has a cart for this store. I did not add items or change that cart. Review it in DoorDash, then retry after it is empty or say `/confetti recover`.',
      };
    }
    if (created.kind === 'adopt') {
      const saved = await updateDoorDashExecution(input.db, {
        executionId: execution.id,
        workspaceId: input.workspaceId,
        checkpoint: 'cart_created',
        cartUuid: created.cartUuid,
      });
      if (saved) execution = saved;
    } else if (created.kind === 'ambiguous') {
      await updateDoorDashExecution(input.db, {
        executionId: execution.id,
        workspaceId: input.workspaceId,
        status: 'needs_review',
        errorCode: 'doordash_cart_state_ambiguous',
      });
      return {
        ok: false,
        error: 'doordash_cart_state_ambiguous',
        retry: false,
        detail:
          'More than one new DoorDash cart appeared while creating this preview. I did not add more items. Review the carts in DoorDash or use `/confetti recover`.',
      };
    } else {
      if (created.kind === 'reuse') {
        const saved = await updateDoorDashExecution(input.db, {
          executionId: execution.id,
          workspaceId: input.workspaceId,
          checkpoint: 'creating_cart',
          cartUuid: created.cartUuid,
        });
        if (saved) execution = saved;
      }
      shouldAddItems = true;
    }
  } else if (
    execution.itemResults.failed.length > 0 &&
    execution.checkpoint !== 'items_added' &&
    execution.checkpoint !== 'previewed' &&
    execution.checkpoint !== 'completed'
  ) {
    shouldAddItems = true;
  }

  if (shouldAddItems) {
    if (execution.checkpoint !== 'creating_cart') {
      const creating = await updateDoorDashExecution(input.db, {
        executionId: execution.id,
        workspaceId: input.workspaceId,
        checkpoint: 'creating_cart',
      });
      if (creating) execution = creating;
    }
    const added = await input.doorDash.addItems({
      storeId: input.storeId,
      menuId: input.menuId,
      items: input.items,
      ...(execution.cartUuid ? { cartUuid: execution.cartUuid } : {}),
      intent: input.intent,
    });
    if (!added.ok) {
      return retryable(`doordash_cart_failed:${added.error}`, 'doordash_cart_failed');
    }
    const resolved = await resolveAddItemsResult(input, execution, added.value);
    if (resolved.kind === 'failed') return resolved.outcome;
    const savedCart = await updateDoorDashExecution(input.db, {
      executionId: execution.id,
      workspaceId: input.workspaceId,
      checkpoint: 'cart_created',
      cartUuid: resolved.cartUuid,
      itemResults: {
        added: input.items.map((item) => ({
          itemId: item.itemId,
          itemName: item.itemName,
          quantity: item.quantity,
        })),
        failed: [],
      },
    });
    if (savedCart) execution = savedCart;
    const itemsSaved = await updateDoorDashExecution(input.db, {
      executionId: execution.id,
      workspaceId: input.workspaceId,
      checkpoint: 'items_added',
    });
    if (itemsSaved) execution = itemsSaved;
  }

  const cartUuid = execution.cartUuid;
  if (!cartUuid) {
    return retryable('doordash_cart_uuid_missing', 'doordash_cart_uuid_missing');
  }

  if (execution.checkpoint === 'cart_created' && execution.itemResults.failed.length === 0) {
    const itemsSaved = await updateDoorDashExecution(input.db, {
      executionId: execution.id,
      workspaceId: input.workspaceId,
      checkpoint: 'items_added',
    });
    if (itemsSaved) execution = itemsSaved;
  }

  if (execution.status === 'needs_review') {
    return {
      ok: false,
      error: execution.errorCode ?? 'doordash_preview_needs_review',
      retry: false,
      detail:
        'This DoorDash preview needs review. I did not submit an order. Use `/confetti recover` after you inspect the cart.',
    };
  }

  const preview = await input.doorDash.previewOrder({
    cartUuid,
    scheduledTime: input.deliveryAt,
    includeWorkBenefits: true,
    intent: input.intent,
  });
  if (!preview.ok) {
    return retryable(`doordash_preview_failed:${preview.error}`, 'doordash_preview_failed');
  }
  if (!preview.value.success || !preview.value.quote) {
    return retryable(
      `doordash_preview_unavailable:${preview.value.message ?? 'unknown'}`,
      'doordash_preview_unavailable',
    );
  }

  const liveTotalCents = quoteTotalCents(preview.value.quote);
  const previewed = await updateDoorDashExecution(input.db, {
    executionId: execution.id,
    workspaceId: input.workspaceId,
    checkpoint: 'previewed',
    quote: preview.value.quote,
    liveTotalCents,
  });
  if (previewed) execution = previewed;

  if (liveTotalCents !== null && liveTotalCents > input.approvedMaxCents) {
    await updateDoorDashExecution(input.db, {
      executionId: execution.id,
      workspaceId: input.workspaceId,
      status: 'needs_review',
      errorCode: 'doordash_quote_exceeds_approved_maximum',
    });
    const approved = (input.approvedMaxCents / 100).toFixed(
      input.approvedMaxCents % 100 === 0 ? 0 : 2,
    );
    const live = (liveTotalCents / 100).toFixed(liveTotalCents % 100 === 0 ? 0 : 2);
    return {
      ok: false,
      error: 'doordash_quote_exceeds_approved_maximum',
      retry: false,
      detail: `The live DoorDash total is $${live}, which is over the approved maximum of $${approved}. I did not submit an order. Cart \`${execution.cartUuid}\` is still in DoorDash. Approve a new maximum or use \`/confetti recover\`.`,
    };
  }

  await updateDoorDashExecution(input.db, {
    executionId: execution.id,
    workspaceId: input.workspaceId,
    status: 'completed',
    checkpoint: 'completed',
    errorCode: null,
  });
  return okPreview(cartUuid, input, preview.value.quote);
};

const okPreview = (
  cartUuid: string | null,
  input: PreviewInput,
  quote: unknown,
): DoorDashPreviewOutcome => ({
  ok: true,
  value: {
    previewOnly: true,
    cartUuid,
    restaurant: input.restaurant,
    deliveryAddress: input.deliveryAddress,
    deliveryAt: input.deliveryAt ?? null,
    quote,
  },
});

const syncApprovedDeliveryAddress = async (
  input: PreviewInput,
): Promise<DoorDashPreviewOutcome | { ok: true; value: Record<string, unknown> }> => {
  if (!input.placeId && !input.addressId) return { ok: true, value: { synced: false } };

  const listed = await input.doorDash.listAddresses(input.intent);
  if (!listed.ok) {
    return retryable(`doordash_address_lookup_failed:${listed.error}`, listed.error);
  }

  const saved =
    matchSavedAddress(listed.value.addresses, input.deliveryAddress) ??
    listed.value.addresses.find((address) => {
      const id = savedAddressId(address);
      return Boolean(input.addressId && id === input.addressId);
    });

  if (saved) {
    if (saved.is_default) return { ok: true, value: { synced: true } };
    const addressId = savedAddressId(saved) ?? input.addressId;
    if (!addressId) {
      return {
        ok: false,
        error: 'doordash_address_missing_id',
        retry: false,
        detail:
          'I found a matching saved DoorDash address but it has no id I can select. I did not submit an order.',
      };
    }
    const set = await input.doorDash.setDefaultAddress({
      addressId,
      intent: input.intent,
    });
    if (!set.ok) return retryable(`doordash_address_set_failed:${set.error}`, set.error);
    return { ok: true, value: { synced: true } };
  }

  if (input.addressId) {
    const set = await input.doorDash.setDefaultAddress({
      addressId: input.addressId,
      intent: input.intent,
    });
    if (!set.ok) return retryable(`doordash_address_set_failed:${set.error}`, set.error);
    return { ok: true, value: { synced: true } };
  }

  const placeId = input.placeId;
  if (!placeId) return { ok: true, value: { synced: false } };

  const added = await input.doorDash.addAddress({
    placeId,
    description: input.deliveryAddress,
    intent: input.intent,
  });
  if (!added.ok) return retryable(`doordash_address_add_failed:${added.error}`, added.error);
  return { ok: true, value: { synced: true } };
};

const resolveAddItemsResult = async (
  input: PreviewInput,
  execution: { id: string; listedCartUuids: string[] },
  added: DoorDashCartMutation,
): Promise<
  { kind: 'ready'; cartUuid: string } | { kind: 'failed'; outcome: DoorDashPreviewOutcome }
> => {
  const itemErrors = added.item_errors ?? [];
  log.info('dd-cli cart add-items result', {
    command: 'cart add-items',
    success: added.success,
    hasCartUuid: Boolean(added.cart_uuid),
    itemErrorCount: itemErrors.length,
  });

  let cartUuid = added.cart_uuid ?? null;
  if (added.success && !cartUuid) {
    const relisted = await input.doorDash.listCarts({
      storeId: input.storeId,
      intent: input.intent,
    });
    if (!relisted.ok) {
      return {
        kind: 'failed',
        outcome: retryable(`doordash_cart_lookup_failed:${relisted.error}`, relisted.error),
      };
    }
    const listedNow = relisted.value.carts.map((cart) => cart.cart_uuid);
    const created = adoptOrCreateCart(
      execution.listedCartUuids,
      listedNow,
      'creating_cart',
      new Set(),
    );
    if (created.kind === 'adopt') cartUuid = created.cartUuid;
    if (created.kind === 'ambiguous') {
      await updateDoorDashExecution(input.db, {
        executionId: execution.id,
        workspaceId: input.workspaceId,
        status: 'needs_review',
        errorCode: 'doordash_cart_state_ambiguous',
        itemResults: { added: [], failed: itemErrors },
      });
      return {
        kind: 'failed',
        outcome: {
          ok: false,
          error: 'doordash_cart_state_ambiguous',
          retry: false,
          detail:
            'More than one new DoorDash cart appeared while creating this preview. I did not add more items. Review the carts in DoorDash or use `/confetti recover`.',
        },
      };
    }
  }

  if (!added.success || itemErrors.length > 0) {
    await updateDoorDashExecution(input.db, {
      executionId: execution.id,
      workspaceId: input.workspaceId,
      status: 'needs_review',
      ...(cartUuid ? { checkpoint: 'cart_created' as const, cartUuid } : {}),
      errorCode: 'doordash_cart_items_need_review',
      itemResults: { added: [], failed: itemErrors },
    });
    const cartNote = cartUuid ? ` Cart \`${cartUuid}\` exists in DoorDash.` : '';
    return {
      kind: 'failed',
      outcome: {
        ok: false,
        error: 'doordash_cart_items_need_review',
        retry: false,
        detail: `${formatCartItemErrors(itemErrors)}${cartNote}`,
      },
    };
  }

  if (!cartUuid) {
    await updateDoorDashExecution(input.db, {
      executionId: execution.id,
      workspaceId: input.workspaceId,
      status: 'needs_review',
      errorCode: 'doordash_cart_items_need_review',
      itemResults: { added: [], failed: [] },
    });
    return {
      kind: 'failed',
      outcome: {
        ok: false,
        error: 'doordash_cart_items_need_review',
        retry: false,
        detail:
          'DoorDash did not create a cart. I did not retry the item batch or submit an order. Use `/confetti recover` after you review DoorDash.',
      },
    };
  }

  return { kind: 'ready', cartUuid };
};

const retryable = (error: string, _code: string | null): DoorDashPreviewOutcome => ({
  ok: false,
  error,
  retry: true,
  detail: 'DoorDash preview is still in progress. I did not submit an order.',
});

const adoptOrCreateCart = (
  listedBefore: string[],
  listedNow: string[],
  checkpoint: string,
  ownedCartUuids: Set<string>,
):
  | { kind: 'create' }
  | { kind: 'adopt'; cartUuid: string }
  | { kind: 'reuse'; cartUuid: string }
  | { kind: 'existing_user_cart' }
  | { kind: 'ambiguous' } => {
  const before = new Set(listedBefore);
  const discovered = listedNow.filter((uuid) => !before.has(uuid));
  const ownedListed = listedNow.filter((uuid) => ownedCartUuids.has(uuid));
  const unowned = listedNow.filter((uuid) => !ownedCartUuids.has(uuid));
  if (checkpoint === 'creating_cart' && discovered.length === 1 && discovered[0]) {
    return { kind: 'adopt', cartUuid: discovered[0] };
  }
  if (checkpoint === 'creating_cart' && discovered.length > 1) return { kind: 'ambiguous' };
  if (ownedListed.length === 1 && ownedListed[0] && unowned.length === 0) {
    return { kind: 'reuse', cartUuid: ownedListed[0] };
  }
  if (listedNow.length > 0 && checkpoint !== 'creating_cart') return { kind: 'existing_user_cart' };
  return { kind: 'create' };
};
