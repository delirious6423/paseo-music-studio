// react-dom is a guest-only dependency of the fixture (tests/ui/runtime); declare just what the harness uses.
declare module "react-dom/client" {
  export function createRoot(container: unknown): { render(node: unknown): void };
}
