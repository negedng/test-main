export function debounce(fn: Function, ms: number) { let t: any; return (...args: any[]) => { clearTimeout(t); t = setTimeout(() => fn(...args), ms); }; }
