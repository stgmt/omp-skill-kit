Feature: Canonical plugin commands
  Scenario: Extension registers only canonical namespaced commands
    Given the native OMP extension module
    When the extension is registered with an isolated host context
    Then exactly five canonical omp-skill-kit commands are registered
    And unprefixed command names are completely absent
    And executing purge without confirmation displays a warning
