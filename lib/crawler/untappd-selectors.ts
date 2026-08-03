// List page selectors.
export const LIST_SELECTORS = { item: '[data-beer-id], .beer-item, .beer-item-container', id: '[data-beer-id]', name: '.beer-name, .name', url: 'a[href*="/beer/"]' } as const;
// Detail tab selectors; each tab is selected by its panel marker.
export const DETAIL_SELECTORS = {
 info: '[data-tab="info"], #info, .beer-details',
 ratings: '[data-tab="ratings"], #ratings, .rating',
 tags: '[data-tab="tags"], #tags, .tag',
 food: '[data-tab="food"], #food, .food-pairing',
 similar: '[data-tab="similar"], #similar, .similar-beer',
} as const;
