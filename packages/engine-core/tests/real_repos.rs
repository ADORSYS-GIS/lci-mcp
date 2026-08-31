//! Integration tests against real Rust and Java source, not synthetic snippets — assertions are
//! cross-checked against a committed golden graph for each fixture rather than invented expectations.
//!
//! Exercises `store`/`index_coordinator` directly, which is exactly what every napi-wrapper method
//! calls straight through to.

use lci_mcp_engine_core::index_coordinator;
use lci_mcp_engine_core::store::{graph, SqliteStore};
use lci_mcp_engine_core::StartIndexOptions;

fn fixture(name: &str) -> std::path::PathBuf {
    std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures").join(name)
}

/// Returns the `TempDir` too, purely to keep it alive for the caller's scope — the sqlite file
/// disappears the moment it drops.
async fn open_and_index(name: &str) -> (SqliteStore, tempfile::TempDir) {
    let db_dir = tempfile::tempdir().unwrap();
    let store = SqliteStore::open(&db_dir.path().join("index.sqlite")).unwrap();
    let handle = index_coordinator::begin_index(&store, &fixture(name), "test-owner", &StartIndexOptions::default())
        .await
        .unwrap();
    index_coordinator::commit_index(&store, &handle.generation_id, "test-owner").unwrap();
    (store, db_dir)
}

fn active_generation_id(store: &SqliteStore) -> String {
    store.get_active_generation().unwrap().unwrap().id
}

#[tokio::test]
async fn axum_service_rust_matches_the_golden_graph_counts() {
    let (store, _db_dir) = open_and_index("axum-service-rust").await;
    let gen_id = active_generation_id(&store);
    let (files, nodes, edges) = store
        .with_conn(|conn| {
            use lci_mcp_engine_core::store as s;
            Ok((s::chunks::count_files(conn, &gen_id)?, s::chunks::count_nodes(conn, &gen_id)?, s::chunks::count_edges(conn, &gen_id)?))
        })
        .unwrap();
    // Pinned against tests/fixtures/axum-service-rust/graph.json (24 nodes, 27 edges: 14 contains,
    // 7 calls, 6 method).
    assert_eq!(nodes, 24);
    assert_eq!(edges, 27);
    // 7, not 4: `count_files` counts every *chunked* file, and the fixture directory also has
    // Cargo.toml, README.md, and the copied graph.json golden itself, all windowed as plain text
    // alongside the 4 real .rs files — real repos always have more chunked files than graph-eligible
    // source files, which is exactly what this assertion is pinning down.
    assert_eq!(files, 7);
}

#[tokio::test]
async fn axum_service_rust_resolves_the_full_handler_to_repo_call_chain() {
    let (store, _db_dir) = open_and_index("axum-service-rust").await;
    let gen_id = active_generation_id(&store);

    // src/handlers.rs#16:list_tickets -> src/repo.rs#22:find_all (golden graph.json)
    let callees = store.with_conn(|conn| graph::get_callees(conn, &gen_id, "src/handlers.rs#16:list_tickets", None)).unwrap();
    assert!(callees.iter().any(|c| c.node_id == "src/repo.rs#22:find_all"), "callees = {callees:?}");

    // src/main.rs#24:main -> src/main.rs#12:router -> src/state.rs#10:new -> src/repo.rs#15:new
    let explored = store
        .with_conn(|conn| graph::explore_symbol(conn, &gen_id, "src/main.rs#24:main", Some(0), Some(3), None))
        .unwrap();
    let ids: std::collections::BTreeSet<_> = explored.nodes.iter().map(|n| n.node_id.as_str()).collect();
    assert!(ids.contains("src/repo.rs#15:new"), "expected the 3-hop chain to reach repo::new; nodes = {ids:?}");
}

#[tokio::test]
async fn spring_boot_maven_java_matches_the_golden_graph_counts() {
    let (store, _db_dir) = open_and_index("spring-boot-maven-java").await;
    let gen_id = active_generation_id(&store);
    let (nodes, edges) = store
        .with_conn(|conn| {
            use lci_mcp_engine_core::store as s;
            Ok((s::chunks::count_nodes(conn, &gen_id)?, s::chunks::count_edges(conn, &gen_id)?))
        })
        .unwrap();
    // Pinned against tests/fixtures/spring-boot-maven-java/graph.json (47 nodes, 47 edges: 27 method,
    // 13 calls, 7 contains).
    assert_eq!(nodes, 47);
    assert_eq!(edges, 47);
}

#[tokio::test]
async fn spring_boot_resolves_the_headline_interface_to_implementation_call() {
    let (store, _db_dir) = open_and_index("spring-boot-maven-java").await;
    let gen_id = active_generation_id(&store);

    // OrderController's `orderService` field is declared as the OrderService *interface*; the only
    // caller of OrderServiceImpl#findById must still be OrderController#getOrder, resolved purely
    // through declared-type + supertype matching, with no real type inference.
    let callers = store
        .with_conn(|conn| {
            graph::get_callers(conn, &gen_id, "src/main/java/com/example/orders/service/OrderServiceImpl.java#19:findById", None)
        })
        .unwrap();
    assert_eq!(callers.len(), 1, "callers = {callers:?}");
    assert_eq!(callers[0].node_id, "src/main/java/com/example/orders/web/OrderController.java#17:getOrder");
}

#[tokio::test]
async fn spring_boot_resolves_a_spring_data_repository_method_with_no_body_anywhere_in_source() {
    let (store, _db_dir) = open_and_index("spring-boot-maven-java").await;
    let gen_id = active_generation_id(&store);

    // OrderRepository#findByCustomerEmail has no body anywhere in source (Spring generates it at
    // runtime) — the framework-facts seam is what lets this resolve at all.
    let callers = store
        .with_conn(|conn| {
            graph::get_callers(conn, &gen_id, "src/main/java/com/example/orders/repo/OrderRepository.java#19:findByCustomerEmail", None)
        })
        .unwrap();
    assert!(
        callers.iter().any(|c| c.node_id == "src/main/java/com/example/orders/service/OrderServiceImpl.java#29:findByCustomerEmail"),
        "callers = {callers:?}"
    );
}

#[tokio::test]
async fn spring_boot_route_nodes_are_findable_and_route_to_their_controller_method() {
    let (store, _db_dir) = open_and_index("spring-boot-maven-java").await;
    let gen_id = active_generation_id(&store);

    let hits = store.with_conn(|conn| graph::find_symbol(conn, &gen_id, "route:GET:/api/orders", None)).unwrap();
    assert!(!hits.is_empty(), "expected at least one Spring route node to be findable");

    let callees = store.with_conn(|conn| graph::get_callees(conn, &gen_id, "route:GET:/api/orders", None)).unwrap();
    assert!(
        callees.iter().any(|c| c.node_id == "src/main/java/com/example/orders/web/OrderController.java#22:listOrders"),
        "callees = {callees:?}"
    );
}
