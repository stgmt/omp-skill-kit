Feature: Native commands
  Scenario: The extension exposes health commands
    Given the omp-skill-kit repository exists
    When I inspect the extension source
    Then it registers status setup doctor purge and dashboard
