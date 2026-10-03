// The onboarding flags in the session payload, from the two cached counts and
// the user's Purdue link. Pure, so it can be tested.
//
// needsPurdueConnection is false both when Purdue is linked and when linking
// is off (PURDUE_AUTH_MODE=off), so it never means "linked": hasPurdueLinked
// does (issue #372).

export function onboardingFlags({ counts, hasPurdueLinked, purdueLinkingEnabled }) {
  return {
    linkedSourceCount: counts.linkedSourceCount,
    classCount: counts.classCount,
    hasPurdueLinked,
    // When Purdue linking is off, never prompt a link and let users attach
    // calendar sources directly (no identity link required).
    needsPurdueConnection: purdueLinkingEnabled ? !hasPurdueLinked : false,
    needsScheduleSource: (purdueLinkingEnabled ? hasPurdueLinked : true) && counts.linkedSourceCount === 0,
  }
}
