Feature: GitHub distribution
  Scenario: The repository is not an npm package
    Given the omp-skill-kit repository exists
    When I inspect package metadata
    Then npm publication is disabled
