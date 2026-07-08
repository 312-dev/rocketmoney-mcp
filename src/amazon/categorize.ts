import Anthropic from "@anthropic-ai/sdk";

// One cheap Haiku call maps a single Amazon item to the best Rocket Money
// category. Ported verbatim from the rocketmoney-amazon-sync skill (same
// candidate IDs, prompt, and overrides). Falls back to Groceries on any failure.

let _anthropic: Anthropic | null = null;
function getAnthropic(): Anthropic {
  if (!_anthropic) _anthropic = new Anthropic();
  return _anthropic;
}

export interface AmazonCategory {
  id: number;
  label: string;
}

export const CANDIDATE_CATEGORIES: Array<AmazonCategory & { hint: string }> = [
  { id: 11, label: "Groceries", hint: "food, pantry, beverages, cleaning supplies, paper goods, everyday household consumables" },
  { id: 19, label: "Personal Care", hint: "toiletries, grooming, hair, shaving, oral/dental care, cosmetics" },
  { id: 12, label: "Health & Wellness", hint: "vitamins, supplements, OTC meds, first aid, fitness gear" },
  { id: 27733, label: "Medical", hint: "medical devices, mobility/health equipment, prescription-adjacent supplies" },
  { id: 20, label: "Pets", hint: "pet food, litter, treats, toys, pet supplies" },
  { id: 8, label: "Family Care", hint: "baby, kids, diapers, childcare items" },
  { id: 13, label: "Home & Garden", hint: "furniture, decor, kitchenware, bedding, tools, garden, home improvement" },
  { id: 516631, label: "Software & Tech", hint: "electronics, gadgets, phone/computer accessories, cables, chargers, software" },
  { id: 7, label: "Entertainment & Rec.", hint: "games, toys, hobbies, books, media, sports/recreation gear" },
  { id: 1, label: "Auto & Transport", hint: "car care, auto parts and accessories" },
  { id: 10, label: "Gifts", hint: "items clearly bought as gifts for others" },
  { id: 24, label: "Travel & Vacation", hint: "luggage, travel gear, trip-related items" },
  { id: 21, label: "Shopping", hint: "general discretionary shopping that does not fit any category above (apparel, misc non-essential goods)" },
];

const DEFAULT_CATEGORY: AmazonCategory = { id: 11, label: "Groceries" };

function buildSystem(categories: Array<{ label: string; hint: string }>): string {
  const list = categories.map((c) => `- "${c.label}": ${c.hint}`).join("\n");
  return `You assign a single Amazon order item to the best-fitting personal budgeting category.

Choose exactly ONE category from this list:
${list}

Rules:
- "Groceries" is the baseline/default for everyday household consumables and food. Use it when nothing more specific clearly fits.
- Prefer a MORE SPECIFIC category when the item clearly belongs there (e.g. vitamins/supplements -> Health & Wellness, phone case/charger/cable -> Software & Tech, dog/cat food or litter -> Pets, toothpaste/shampoo/razors -> Personal Care, board game/toy -> Entertainment & Rec.).
- Decide based on what the ITEM is, not the store.
- The label you return MUST be copied exactly from the list above.

Respond with ONLY a JSON object, no prose:
{"category": "<one label from the list above>"}`;
}

const SYSTEM = buildSystem(CANDIDATE_CATEGORIES);

const OVERRIDES: Array<{ match: string; label: string }> = [
  { match: "scrub daddy", label: "Groceries" },
  { match: "scrub mommy", label: "Groceries" },
  { match: "whitening", label: "Personal Care" },
  { match: "dollar shave club", label: "Personal Care" },
  { match: "owala", label: "Home & Garden" },
  { match: "meguiar", label: "Auto & Transport" },
];

function resolve(label: string): AmazonCategory {
  const found = CANDIDATE_CATEGORIES.find((c) => c.label.toLowerCase() === label.toLowerCase());
  return found ? { id: found.id, label: found.label } : DEFAULT_CATEGORY;
}

export async function categorizeAmazonItem(itemName: string): Promise<AmazonCategory> {
  const lower = itemName.toLowerCase();
  const override = OVERRIDES.find((o) => lower.includes(o.match));
  if (override) return resolve(override.label);
  if (!process.env.ANTHROPIC_API_KEY) return DEFAULT_CATEGORY;

  try {
    const res = await getAnthropic().messages.create({
      model: "claude-haiku-4-5-20251001",
      max_tokens: 64,
      system: SYSTEM,
      messages: [{ role: "user", content: `Item: ${itemName}` }],
    });
    const first = res.content[0];
    const text = first && first.type === "text" ? first.text : "";
    const match = text.match(/"category"\s*:\s*"([^"]+)"/);
    return match ? resolve(match[1]) : DEFAULT_CATEGORY;
  } catch (err) {
    console.error(`[amazon-categorize] failed for "${itemName}", defaulting to Groceries:`, err);
    return DEFAULT_CATEGORY;
  }
}
