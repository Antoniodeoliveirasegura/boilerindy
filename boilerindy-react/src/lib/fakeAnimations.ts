// For the unit tests only. jsdom has no Web Animations API, so the motion
// code (lib/motion.ts) treats it as a browser that cannot animate: overlays
// leave at once and nothing rises. A test that needs an exit or an entrance in
// flight installs this fake on Element.prototype and finishes the animations
// itself.

export type FakeAnimation = Animation & { finish: () => void; cancel: () => void }

/** A running animation that ends when the test says so. */
export function fakeAnimation({ endTime = 260, name }: { endTime?: number; name?: string } = {}): FakeAnimation {
  let settle: (value: Animation) => void = () => {}
  let fail: (reason: unknown) => void = () => {}
  const finished = new Promise<Animation>((resolve, reject) => {
    settle = resolve
    fail = reject
  })
  // A cancelled animation rejects its promise; nobody here waits on that rejection.
  finished.catch(() => undefined)
  const animation = {
    effect: { getComputedTiming: () => ({ endTime }) },
    finished,
    animationName: name,
    finish: () => settle(animation as unknown as Animation),
    cancel: () => fail(new DOMException('The animation was cancelled.', 'AbortError')),
  }
  return animation as unknown as FakeAnimation
}

/**
 * Gives every element getAnimations(), answered by `running` for the element
 * asked. Returns a function that takes it away again.
 */
export function installFakeAnimations(running: (el: Element) => Animation[]): () => void {
  const proto = Element.prototype as unknown as { getAnimations?: unknown }
  const had = Object.prototype.hasOwnProperty.call(proto, 'getAnimations')
  const before = proto.getAnimations
  proto.getAnimations = function getAnimations(this: Element) {
    return running(this)
  }
  return () => {
    if (had) proto.getAnimations = before
    else delete proto.getAnimations
  }
}
