/**
 * Short stories for the varieties we are likely to sell, shown on the product page and the
 * home shelves. Products are added by managers, so a variety missing here simply shows no story.
 * Seasons are the usual months; the shop's stock is what decides what is on sale.
 */
export interface VarietyStory {
  name: string
  from: string
  taste: string
  bestFor: string
  season: string
}

const STORIES: VarietyStory[] = [
  {
    name: 'Alphonso',
    from: 'The Konkan coast of Maharashtra, around Ratnagiri and Devgad, where it is called Hapus.',
    taste: 'Saffron flesh, rich and sweet, with a strong scent and almost no fibre.',
    bestFor: 'Eating in slices, aamras, milkshakes and desserts.',
    season: 'Usually April to early June.',
  },
  {
    name: 'Badami',
    from: 'North Karnataka, which is why it is often called Karnataka Alphonso.',
    taste: 'Close to Alphonso: sweet and smooth, a little milder, with very little fibre.',
    bestFor: 'Eating fresh, and aamras on a budget.',
    season: 'Usually April to June.',
  },
  {
    name: 'Kesar',
    from: 'The foothills of Gir in Gujarat.',
    taste: 'Bright orange flesh, very sweet and fragrant.',
    bestFor: 'Aamras, shrikhand and ice cream.',
    season: 'Usually May to July.',
  },
  {
    name: 'Banganapalli',
    from: 'Kurnool and nearby districts of Andhra Pradesh. Also called Benishan.',
    taste: 'Large and golden, mildly sweet, firm and fibreless.',
    bestFor: 'Eating in slices and fruit salads.',
    season: 'Usually April to June.',
  },
  {
    name: 'Mallika',
    from: 'A cross of Neelam and Dasheri, grown widely around Karnataka.',
    taste: 'Honey-sweet, with deep orange flesh and little fibre.',
    bestFor: 'Eating fresh and desserts.',
    season: 'Usually May and June.',
  },
  {
    name: 'Imam Pasand',
    from: 'Andhra Pradesh and Tamil Nadu.',
    taste: 'Big, juicy and rich, with a thin skin.',
    bestFor: 'Eating fresh.',
    season: 'Usually May and June.',
  },
  {
    name: 'Totapuri',
    from: 'Karnataka, Andhra Pradesh and Tamil Nadu. Named for its parrot-beak tip.',
    taste: 'Tangy and firm, less sweet than the others.',
    bestFor: 'Pickles, salads and pulp.',
    season: 'Usually May to July.',
  },
]

const byKey = new Map(STORIES.map((s) => [s.name.toLowerCase(), s]))

/** The story for a product's variety (or a variety named in its title), if we have one. */
export function storyFor(variety: string, name = ''): VarietyStory | null {
  const v = variety.trim().toLowerCase()
  if (byKey.has(v)) return byKey.get(v)!
  const text = `${variety} ${name}`.toLowerCase()
  return STORIES.find((s) => text.includes(s.name.toLowerCase())) ?? null
}
