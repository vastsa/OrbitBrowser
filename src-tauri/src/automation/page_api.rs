use serde::Serialize;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PageApiCapability {
    pub name: &'static str,
    pub implemented: bool,
}

pub fn capabilities() -> Vec<PageApiCapability> {
    [
        "goto",
        "click",
        "type",
        "wait",
        "evaluate",
        "screenshot",
        "title",
        "url",
    ]
    .into_iter()
    .map(|name| PageApiCapability {
        name,
        implemented: false,
    })
    .collect()
}
