// jsdom's window is 1024px wide, narrower than Loom's drawer breakpoint: the
// tests work in a desktop-sized window unless they make it narrower themselves.
Object.defineProperty(window, 'innerWidth', { configurable: true, writable: true, value: 1440 });
