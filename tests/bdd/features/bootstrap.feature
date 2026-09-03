Feature: Background runtime bootstrap
  Scenario: Isolated bootstrap state progression
    Given an empty isolated skill kit home
    When the state store is initialized
    Then the initial phase is absent
    And the runtime manifest lock digests match target specifications
    And the installer launches with Bun execution flag

  Scenario: Automatic installer supervision and orphaned state recovery
    Given an empty isolated skill kit home
    When session start is triggered in the extension
    Then exactly one installer process is launched
    And the footer status displays the installation progress step
    When the state is an orphaned active phase without a live lock
    And session start is triggered again
    Then the orphaned installation is restarted automatically
