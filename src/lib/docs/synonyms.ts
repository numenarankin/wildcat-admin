/**
 * What operators call things, mapped to what the docs call them.
 *
 * A pumper asks "how do I stick a tank"; the doc is called "Record a tank
 * gauge". Plain keyword matching answers that with nothing, which reads as "the
 * docs do not cover it" rather than "you used the other word for it". Each
 * group below is a set of phrases that mean the same thing in this app, and
 * matching any member searches for all of them.
 *
 * Groups are symmetric and unranked on purpose: there is no canonical term, and
 * deciding one would be an editorial claim the corpus does not make. A
 * synonym-derived term scores lower than one the user actually typed (see
 * `search.ts`), which is what keeps a broad group from drowning the query.
 *
 * Multi-word members are matched as phrases against the whole question, so
 * "shut in" can be a group member without "in" ever being a search term.
 */
export const SYNONYM_GROUPS: readonly (readonly string[])[] = [
  // --- Doing things, said the several ways people say them ---
  ["add", "create", "new", "set up", "start", "make", "enter", "put in"],
  ["edit", "change", "update", "correct", "fix", "amend"],
  ["delete", "remove", "get rid of", "take off", "erase"],
  ["find", "search", "look up", "where is", "locate"],

  // --- Field vocabulary ---
  ["gauge", "gauging", "stick", "sticking", "tank level", "tape"],
  ["strapping", "strap", "capacity", "tank chart"],
  ["run ticket", "load", "haul", "hauled", "pickup", "picked up", "truck"],
  ["downtime", "shut in", "shutin", "off production", "idle", "not running"],
  ["fluid shot", "fluid level", "sonolog", "echometer"],
  ["well test", "potential test", "test a well"],
  ["allocation", "split", "divide", "apportion", "share out"],
  ["disposal", "swd", "saltwater", "salt water", "injection", "injector"],
  ["water", "brine", "produced water"],
  ["oil", "crude"],
  ["gas", "casinghead", "mcf"],
  ["production", "volumes", "barrels", "bbl", "output", "numbers"],
  ["tank", "vessel", "stock tank"],
  ["battery", "tank battery"],
  ["meter", "orifice", "ebm"],
  ["lease", "unit", "property"],
  ["well", "wellbore"],
  ["rrc", "railroad commission", "state records", "public records", "w-10", "g-1"],

  // --- Money ---
  ["statement", "check stub", "checkstub", "settlement", "remittance", "purchaser statement"],
  ["invoice", "bill", "payable", "vendor bill", "jib"],
  ["revenue", "income", "sales", "proceeds"],
  ["price", "pricing", "posted price", "benchmark"],
  ["royalty", "interest owner", "nri", "working interest", "division order"],
  ["subscription", "plan", "card", "payment method", "billing", "charge"],
  ["ledger", "transactions", "books"],

  // --- The app ---
  ["orion", "ai", "assistant", "bot", "copilot"],
  ["credits", "ai credits", "tokens", "usage"],
  ["report", "digest", "summary"],
  ["scout", "prospect", "prospecting", "permits"],
  ["file", "document", "attachment", "pdf", "upload", "scan"],
  ["note", "memo"],
  ["project", "job"],
  ["agenda", "calendar", "schedule", "event", "task", "todo", "to do"],
  ["message", "chat", "dm", "text", "group chat"],
  ["comment", "reply", "mention"],
  ["notification", "alert", "notify", "email me", "reminder"],
  ["permission", "access", "role", "rights", "allowed", "see"],
  ["coworker", "employee", "teammate", "staff", "crew", "pumper", "user", "someone"],
  ["invite", "invitation", "add someone", "onboard"],
  ["password", "sign in", "log in", "login", "credentials"],
  ["email address", "email"],
  ["workspace", "organization", "org", "company", "account"],
  ["map", "location", "coordinates", "survey"],
  ["voice", "talk", "speak", "out loud", "microphone"],
];
