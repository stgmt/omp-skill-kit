Feature: Background runtime bootstrap
  Scenario: Isolated bootstrap state progression
    Given an empty isolated skill kit home
    When the state store is initialized
    Then the initial phase is absent
    And the runtime manifest lock digests match target specifications
    And the installer launches with Bun execution flag
