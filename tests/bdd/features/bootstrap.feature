Feature: Background runtime bootstrap
  Scenario: The plugin declares a native OMP extension
    Given the omp-skill-kit repository exists
    When I inspect the plugin manifest
    Then it declares the extension bundle
