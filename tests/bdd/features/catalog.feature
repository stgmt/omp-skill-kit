Feature: Catalog filtering
  Scenario: The catalog has a bundled routing fixture
    Given the omp-skill-kit repository exists
    When I inspect the skill catalog fixture
    Then the fixture contains only a name and description
