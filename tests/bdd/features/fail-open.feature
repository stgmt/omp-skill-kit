Feature: Fail-open routing
  Scenario: The client has a bounded route deadline
    Given the omp-skill-kit repository exists
    When I inspect the routing constants
    Then routing has a 750 millisecond deadline
