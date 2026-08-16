/**
 * tests/_helpers/router-test-helper.ts
 *
 * Test-only re-export of the in-memory skill registry plus a reset
 * helper. The harness router module keeps state in a module-level Map
 * which makes tests order-dependent — this helper gives every test file
 * a clean slate without leaking into other suites.
 */

import {
  registerSkill,
  listSkills,
  unregisterSkill,
} from "../../lib/harness/router.ts";
import type { Skill } from "../../lib/harness/types.ts";

export { registerSkill, listSkills, unregisterSkill };

/** Wipe the in-memory registry so the calling test starts clean. */
export function _resetSkillsForTests(): void {
  for (const s of listSkills()) {
    unregisterSkill(s.id);
  }
}

export type { Skill };