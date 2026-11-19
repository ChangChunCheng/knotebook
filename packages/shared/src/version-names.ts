// Derived from the uuid's random v4 bits, not stored. Names repeat (4096 combinations); the short id disambiguates.
// The word lists are frozen once released: any change, even appending, renames existing versions.
// No imports: e2e imports this file by relative path.
export const VERSION_NAME_ADJECTIVES: readonly string[] = [
  "able", "agile", "amber", "ample", "azure", "bold", "brave", "bright",
  "brisk", "calm", "candid", "cheery", "civil", "clever", "cosmic", "crisp",
  "curious", "daring", "deft", "eager", "early", "earnest", "fair", "fancy",
  "fleet", "fond", "frank", "gentle", "glad", "golden", "grand", "happy",
  "hardy", "honest", "humble", "jolly", "keen", "kind", "lively", "loyal",
  "lucid", "merry", "mellow", "mighty", "modest", "noble", "plucky", "polite",
  "proud", "quick", "quiet", "rapid", "ready", "sharp", "shiny", "snowy",
  "steady", "sunny", "swift", "tidy", "upbeat", "vivid", "warm", "witty",
];

export const VERSION_NAME_NOUNS: readonly string[] = [
  "badger", "beaver", "bison", "bobcat", "crane", "cricket", "dolphin", "eagle",
  "falcon", "ferret", "finch", "fox", "gecko", "gibbon", "heron", "hare",
  "ibis", "jackal", "jaguar", "koala", "lemur", "leopard", "lynx", "magpie",
  "marten", "mole", "moose", "newt", "ocelot", "orca", "osprey", "otter",
  "owl", "panda", "parrot", "pelican", "penguin", "puffin", "quail", "rabbit",
  "raven", "robin", "salmon", "seal", "sparrow", "squid", "stork", "swan",
  "tapir", "tiger", "toucan", "trout", "turtle", "walrus", "weasel", "whale",
  "wombat", "wolf", "wren", "yak", "zebra", "bee", "crow", "deer",
];

const HEX32 = /^[0-9a-f]{32}$/;

export function derivedVersionName(id: string): string {
  const h = id.replace(/-/g, "").toLowerCase();
  if (!HEX32.test(h)) return "version";
  const adjective = VERSION_NAME_ADJECTIVES[parseInt(h.slice(20, 24), 16) % 64];
  const noun = VERSION_NAME_NOUNS[parseInt(h.slice(24, 28), 16) % 64];
  return `${adjective}-${noun}`;
}
