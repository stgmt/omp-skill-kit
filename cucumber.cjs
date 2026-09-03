module.exports = {
  default: {
    require: ["tests/bdd/steps/**/*.ts"],
    requireModule: ["tsx/cjs"],
    format: ["progress", "json:reports/bdd.json"],
    paths: ["tests/bdd/features/**/*.feature"],
  },
};
