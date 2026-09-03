Feature: Canonical plugin commands
  Scenario: Extension registers only canonical namespaced commands
    Given the native OMP extension module
    When the extension is registered with an isolated host context
    Then exactly six canonical omp-skill-kit commands are registered
    And unprefixed command names are completely absent
    And executing purge without confirmation displays a warning

  Scenario: Command behavior and diagnostics reporting
    Given an isolated skill kit home with an ongoing installation
    When setup command is executed again
    Then setup reports that installation is already running without spawning a new process
    When help, status, and doctor commands are executed
    Then each output reports the logs directory and exact component log paths
