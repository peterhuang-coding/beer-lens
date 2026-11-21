# 2026-10-24 menu source audit — three undated-photo additions

Scope date: **2026-10-24** (parent independently browsed the public pages below;
all access was `web_index_or_cache`, i.e. fetched/indexed web views, not onsite
verification).

Data file: `data/menus/elnido-2026-10-additions.json` (3 entries,
`menu_id: elnido-2026-10`, entry ids carry the `-additions-` disambiguator and
never collide with the original ids `elnido-2026-10-10` / `-16`).

These rows come from a **separate, undated user-photo transcription**
(`observation.observed_at = "undated-user-photo"`): tap 1
Spezial Gold 70 CNY/425ml, tap 10 Cactus 65 CNY/300ml, tap 16
Blackberry/Blueberry/mango 80 CNY/300ml. They are **not** the dated
2026-10-20 snapshot in `data/menus/elnido-2026-10.json`; the two transcriptions
are distinct observations and neither represents current inventory. No image
is stored. The tap number is provenance metadata only, never an identity key.
Photo price/volume belong to that photo only; they are never injected into
evidence or another menu.

Two products are **confirmed**; the Arpus row is strictly
**version_unresolved**.

---

## 1. Tap 1 — Waldhaus / Spezial Gold — confirmed

- Source (brewery, checked 2026-10-24):
  https://www.waldhaus-bier.de/en/beer-specialties/spezial-gold/
- Fields supported: identity (`Spezial Gold`, brewery Waldhaus), style Lager,
  ABV 5.60% (matches the photo's 5.6%), ingredient-origins, producer
  description. Brewery identity also accepts the normalized exact labels
  `Brauerei Waldhaus` / `Privatbrauerei Waldhaus` only.
- Photo observation: Lager, 5.6%, 70 CNY / 425 ml.
- Limitations:
  - Whole hop cones are described by **origin regions** (Tettnang / Spalt /
    Hallertau); these are not verified specific hop cultivars.
  - Barley malt is described as from Baden-Württemberg / Rheinland-Pfalz.
  - "Balanced, full, malty character" is producer marketing, not measured
    bitterness; the page's flavor-scale value **Bitterunits 4 is not an IBU
    measurement**.
  - "Long-standing classic from the founder's time" is a producer description
    only — awards do not establish flagship or bestseller status; no such
    core-range or sales claim was captured.
  - No product retail price was captured; nothing is compared with the 70 CNY
    draft price.

## 2. Tap 10 — Tilted Barn / Cactus — confirmed

- Sources (checked 2026-10-24):
  - Brewery's own Untappd **venue menu** page (community):
    https://untappd.com/v/tilted-barn-brewery/2296372 — identity, 7.8%,
    Imperial/Double New England/Hazy; page also **displays 70 IBU**. There is
    no IBU field in the supplement schema, so 70 IBU survives only as an
    explicitly attributed displayed-value note; no rating is used.
  - BeerAdvocate exact beer page (community):
    https://www.beeradvocate.com/beer/profile/37721/264713/ — corroborates
    name/brewery/7.8% Hazy Imperial IPA. Its "soft mouthfeel,
    pineapple/mango/guava" wording is a **community-listed sensory
    description**, not an official tasting note and not evidence of fruit
    ingredients.
  - Brewery official past/present page (brewery):
    https://www.tiltedbarnbrewery.com/beers-past-present-1 — currently lists
    only the heading **DDH Cactus** (7.8%, double-dry-hop descriptor).
- Photo observation: Double Hazy IPA, 7.8%, 65 CNY / 300 ml.
- Limitations / negatives:
  - **DDH Cactus is a different variant.** Its double-dry-hop process/hop
    claims are not transferred to bare "Cactus"; "DDH Cactus" must not match
    the photo row.
  - Parent rechecked the [Bissell brewery's collaboration page](https://bissellbrothers.com/beer/cactus-collab-with-tilted-barn-brewery/) on 2026-10-24; its identity and hop list support only this different product.
  - The **Bissell collaboration is a different beer**; its
    Amarillo/Citra/El Dorado/Mosaic hop list does not apply, and a "Cactus"
    under the Bissell brewery must not match.
  - No flagship evidence and no current price; the 65 CNY photo price is not
    compared with anything.

## 3. Tap 16 — Arpus / "Blackberry/Blueberry/mango" — version_unresolved

- Source (brewery shop, observed and checked 2026-10-24):
  https://arpusbrewing.co/products/blackberry-x-blueberry-x-mango-x-pineapple-x-peanut-butter-smoothie-sour-ale
- The exact full product is **Blackberry x Blueberry x Mango x Pineapple x
  Peanut Butter Smoothie Sour Ale**, 4.5%. The photo shows only the **short
  three-fruit title** "Blackberry/Blueberry/mango" (the Chinese line
  花落花间影亦花 is deliberately not used as an identity key; `name_zh` is
  empty), so matching to the full product stays **VERSION_UNRESOLVED**:
  - runtime canonical/style/abv stay null; the current OCR 4.5% and
    "Smoothie Sour" survive only via explicit OCR evidence markers;
  - the full title is rendered only as a possible candidate
    ("可能候选/身份未定"), never added as a confirmed alias of the short
    title;
  - pineapple and especially **peanut butter (花生酱) are unconfirmed
    ingredients** for the photographed beer and must not be transferred.
  - No rating / IBU / hops / "classic" facts.
- Candidate-only retail offer (preserved in `field_disagreements.candidate_offer`,
  not rendered into evidence, not used in matching): 0.44 L (440 ml) can,
  **EUR 6.19 tax included**, shipping extra, observed/checked 2026-10-24.
- Non-comparability (hard rule): a shipped **0.44 L can retail** offer is a
  different form from a **300 ml bar draft** at 80 CNY, and the version is
  unresolved. No EUR/CNY FX rate was captured. Therefore the can offer is
  **never compared** with the photographed draft price: there is no
  same-draft comparison, no "bar premium", no `originBenchmark`, and no
  `savingsVsOrigin` computation. The EUR price/volume appear only in the
  structured `candidate_offer` record and this audit, never in reader-visible
  evidence text.

---

## Reader / provenance mechanics

- `readMenuSupplements()` reads two fixed paths only — the original
  `elnido-2026-10.json` and `elnido-2026-10-additions.json` — with no
  directory discovery; each file is read independently fail-soft (a missing or
  malformed file degrades to [] and never blocks the other), yielding 17 + 3
  = 20 validated rows, originals first.
- Evidence dates are derived per row/per source: old rows render the
  2026-10-20 transcription with per-source 2026-10-21 check dates; addition
  rows render "未标日期用户照片转录行（独立于 2026-10-20 快照的另一次转录）"
  with per-source 2026-10-24 check dates, and an explicit scope clause that the
  two observations must not be substituted for one another.
- Matching remains normalized-exact title (+ brewery when supplied); tap
  numbers never participate; ambiguity or a wrong brewery/variant leaves the
  candidate unmatched. Matched addition rows carry no usable rating/ID/URL and
  clear inherited scores, label art, value/origin/savings fields exactly like
  the original supplement.
