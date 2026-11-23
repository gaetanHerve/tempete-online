import { configDefaults, defineConfig } from 'vitest/config';

// Tests de l'appli ; les scripts de mesure (scripts/) se lancent à part, avec leur propre config.
export default defineConfig({
  test: { exclude: [...configDefaults.exclude, 'scripts/**'] },
});
