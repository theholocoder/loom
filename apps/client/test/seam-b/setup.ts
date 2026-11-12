// jsdom's window is 1024px wide, narrower than Loom's drawer breakpoint: the
// tests work in a desktop-sized window unless they make it narrower themselves.
Object.defineProperty(window, 'innerWidth', { configurable: true, writable: true, value: 1440 });

// jsdom has no canvas, and says so on every try: Pele, measuring a diagram's text, then estimates it.
HTMLCanvasElement.prototype.getContext = (() => null) as typeof HTMLCanvasElement.prototype.getContext;
