import { describe, expect, it } from 'vitest';
import { formatCartItemErrors } from '@/integrations/doordash/cart-item-errors';
import {
  applyDefaultSingleChoices,
  arrangeSelectedOptions,
  missingRequiredOptionNames,
  normalizeItemDetails,
  summarizeItemDetails,
} from '@/integrations/doordash/item-details';

describe('cart item errors', () => {
  it('names required option groups and their choices', () => {
    expect(
      formatCartItemErrors([
        {
          message: 'Failed to add item [Gourmet Veggie]',
          request: { item_name: 'Gourmet Veggie' },
          required_options: [
            {
              name: 'Size',
              options: [
                { id: 'opt-small', name: 'SMALL', price: 24.98 },
                { id: 'opt-large', name: 'LARGE', price: 41.64 },
              ],
            },
          ],
        },
      ]),
    ).toContain('Gourmet Veggie needs Size: SMALL ($24.98) and LARGE ($41.64)');
    expect(
      formatCartItemErrors([
        {
          item_name: 'Gourmet Veggie',
          required_options: [{ name: 'Size' }, { name: 'Crust' }],
        },
      ]),
    ).toContain('Gourmet Veggie needs Size and Crust');
    expect(
      formatCartItemErrors([
        {
          item_name: 'Gourmet Veggie',
          required_options: [{ name: 'Size' }, { name: 'Crust' }],
        },
      ]),
    ).not.toContain('cart UUID');
  });
});

describe('item details', () => {
  it('reads wrapped extras that use title and option_id', () => {
    const details = normalizeItemDetails({
      success: true,
      item: {
        item_id: 'item-1',
        name: 'Vegetarian Spicy Himalayan Pizza',
        extras: [
          {
            title: 'Size',
            min_num_options: 1,
            options: [
              {
                option_id: 'opt-size-small',
                name: 'SMALL',
                extras: [
                  {
                    title: 'Crust',
                    min_num_options: 1,
                    options: [{ option_id: 'opt-crust-regular', name: 'Regular Crust' }],
                  },
                  {
                    title: 'Cheese',
                    min_num_options: 1,
                    options: [{ option_id: 'opt-cheese-mozz', name: 'Mozzarella Cheese' }],
                  },
                ],
              },
            ],
          },
        ],
      },
    });

    expect(summarizeItemDetails(details).hasRequiredOptions).toBe(true);
    expect(missingRequiredOptionNames(details, undefined)).toEqual(['Size']);
    expect(
      missingRequiredOptionNames(details, [{ id: 'opt-size-small', name: 'SMALL', quantity: 1 }]),
    ).toEqual(['Crust', 'Cheese']);
    const withDefaults = applyDefaultSingleChoices(details, [
      { id: 'opt-size-small', name: 'SMALL', quantity: 1 },
    ]);
    expect(missingRequiredOptionNames(details, withDefaults)).toEqual([]);
    expect(withDefaults).toEqual([
      expect.objectContaining({
        id: 'opt-size-small',
        options: expect.arrayContaining([
          expect.objectContaining({ id: 'opt-crust-regular' }),
          expect.objectContaining({ id: 'opt-cheese-mozz' }),
        ]),
      }),
    ]);
  });

  it('reports missing required extras until matching option ids are selected', () => {
    const details = normalizeItemDetails({
      item_id: 'item-1',
      name: 'Gourmet Veggie',
      extras: [
        {
          name: 'Size',
          min_num_options: 1,
          options: [{ id: 'opt-size-large', name: 'Large' }],
        },
      ],
    });

    expect(summarizeItemDetails(details).hasRequiredOptions).toBe(true);
    expect(missingRequiredOptionNames(details, undefined)).toEqual(['Size']);
    expect(
      missingRequiredOptionNames(details, [{ id: 'opt-size-large', name: 'Large', quantity: 1 }]),
    ).toEqual([]);
  });

  it('nests a flat list of option names under the chosen size', () => {
    const details = normalizeItemDetails({
      item: {
        name: 'Cheese',
        extras: [
          {
            title: 'Size',
            min_num_options: 1,
            options: [
              {
                option_id: 'opt-size-large',
                name: 'LARGE',
                extras: [
                  {
                    title: 'Crust',
                    min_num_options: 1,
                    options: [
                      { option_id: 'opt-crust-thin', name: 'Thin Crust' },
                      { option_id: 'opt-crust-regular', name: 'Regular Crust' },
                    ],
                  },
                  {
                    title: 'Sauce',
                    min_num_options: 1,
                    options: [
                      { option_id: 'opt-sauce-red', name: 'Red Sauce' },
                      { option_id: 'opt-sauce-bbq', name: 'BBQ Sauce' },
                    ],
                  },
                  {
                    title: 'Cheese',
                    min_num_options: 1,
                    options: [{ option_id: 'opt-cheese-base', name: 'Base Cheese' }],
                  },
                  {
                    title: 'Toppings',
                    min_num_options: 1,
                    options: [
                      { option_id: 'opt-olive', name: 'Black Olives' },
                      { option_id: 'opt-mushroom', name: 'Mushrooms' },
                    ],
                  },
                ],
              },
            ],
          },
        ],
      },
    });

    const arranged = arrangeSelectedOptions(details, [
      { name: 'Large' },
      { name: 'Thin Crust' },
      { name: 'Red Sauce' },
      { name: 'olives' },
    ]);
    const filled = applyDefaultSingleChoices(details, arranged);
    expect(missingRequiredOptionNames(details, filled)).toEqual([]);
    expect(filled).toEqual([
      expect.objectContaining({
        id: 'opt-size-large',
        options: expect.arrayContaining([
          expect.objectContaining({ id: 'opt-crust-thin', name: 'Thin Crust' }),
          expect.objectContaining({ id: 'opt-sauce-red', name: 'Red Sauce' }),
          expect.objectContaining({ id: 'opt-cheese-base', name: 'Base Cheese' }),
          expect.objectContaining({ id: 'opt-olive', name: 'Black Olives' }),
        ]),
      }),
    ]);
  });
});
