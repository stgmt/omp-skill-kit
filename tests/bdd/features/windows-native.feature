Feature: Windows native compatibility
  Scenario: Space-containing paths, executable resolution, and concurrency
    Given a path containing spaces and unicode characters
    When environment variables and child processes are launched
    Then process spawning handles quotes and paths correctly
    And multiple client instances share the same bridge endpoint
