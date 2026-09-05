/**
 * The shortest key the app will hash.
 *
 * `#F5H4` opened a session. Four characters is ~19.6 bits — the whole keyspace
 * is 810,000 rooms — and nothing downstream objects: the relay routes a room
 * hash without caring how much entropy went into it, so the client is the only
 * place this can be enforced. It was enforced at four, which is to say not at
 * all.
 *
 * The floor is a compatibility surface in both directions. Too low and a room
 * is guessable; too high and every link an older build handed out is dead. Six
 * is the shortest key any build ever generated, which is why it is the number.
 *
 * Usage: node tests/unit/keyfloor.mjs
 */

import assert from "node:assert/strict";
import { KEY } from "../../src/core/config.js";
import * as keys from "../../src/core/keys.js";

let pass = 0, fail = 0;
const ok = (name, good, detail = "") => {
  good ? pass++ : fail++;
  console.log(`  ${good ? "PASS" : "FAIL"}  ${name}${detail ? "  — " + detail : ""}`);
};

console.log("\nThe key-length floor\n");

ok("the floor is six", KEY.MIN_LENGTH === 6, String(KEY.MIN_LENGTH));
ok("...and no shorter than any key a build ever produced",
   KEY.MIN_LENGTH <= KEY.LENGTH && KEY.MIN_LENGTH <= KEY.LONG_LENGTH,
   "raising it past KEY.LENGTH would reject the app's own links");

/* THE BUG: this is the exact string that opened a session. */
ok("F5H4 is refused", !keys.isValid("F5H4"));
ok("...and says why", keys.rejectReason("F5H4") === "short",
   keys.rejectReason("F5H4"));

for (const k of ["A", "A2", "A2B", "A2B4", "A2B4C"])
  ok(`${k} (${k.length}) is refused`, !keys.isValid(k));

for (const k of ["A2B4CD", "D75LVX9QR", "D75LVX9QRS"])
  ok(`${k} (${k.length}) is accepted`, keys.isValid(k),
     "six is the floor, not ten — older links have to keep working");

console.log("\nWhat the floor must not break\n");

const generated = keys.generate(KEY.LENGTH);
ok("a generated key clears it", keys.isValid(generated), generated);
ok("...and so does a long one", keys.isValid(keys.generate(KEY.LONG_LENGTH)));

/* Permissive about the ALPHABET, strict about the LENGTH. A key from another
   build may contain letters the generator never emits. */
ok("a key using letters we never generate still works", keys.isValid("D75LVX9QRS"),
   "L is not in KEY.ALPHABET and the room is still real");

/* Normalisation runs first, so punctuation and case cannot smuggle length in. */
ok("separators do not count towards the length", !keys.isValid("a2-b4"),
   "normalise() strips them, leaving four");
ok("...nor does whitespace", !keys.isValid("  a2b4  "));

console.log("\nThe other end\n");

ok("the ceiling is still 32", KEY.MAX_LENGTH === 32);
ok("33 characters is refused", !keys.isValid("A".repeat(33)));
ok("...and says so distinctly", keys.rejectReason("A".repeat(33)) === "long",
   "the gate prints a different sentence for each");

console.log("\nAbsent is not invalid\n");

/* Boot's whole decision rests on this. An EMPTY fragment means "generate one",
   the ordinary first visit; a SHORT one is a request being declined. Collapsing
   the two either gates every new visitor or silently swallows a bad link. */
ok("an empty key reports 'empty', not 'short'", keys.rejectReason("") === "empty");
ok("...and so does one that normalises away", keys.rejectReason("///") === "empty");

console.log("\nThe number the gate quotes\n");

ok("four characters is under 20 bits", keys.entropyBits(4) < 20,
   `${keys.entropyBits(4).toFixed(1)} bits`);
ok("...and the floor clears 29", keys.entropyBits(KEY.MIN_LENGTH) >= 29,
   `${keys.entropyBits(KEY.MIN_LENGTH).toFixed(1)} bits`);

console.log(`\n${"=".repeat(58)}`);
console.log(`KEY FLOOR: ${pass}/${pass + fail} passed`);
console.log("=".repeat(58) + "\n");
assert.equal(fail, 0, `${fail} key-floor assertions failed`);
