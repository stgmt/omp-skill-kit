module.exports = {
  default: {
    require: ["tests/bdd/steps/**/*.ts"],
    requireModule: ["tsx/cjs"],
    format: ["progress-bar", "json:reports/bdd.json"],
    paths: ["tests/bdd/features/**/*.feature"],
    publishQuiet: true,
  },
};
