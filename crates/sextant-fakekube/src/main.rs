use std::path::PathBuf;

use sextant_fakekube::{FakeKube, FakeKubeConfig};

fn usage() -> ! {
    eprintln!("usage: sextant-fakekube --kubeconfig <path> --context <name>");
    std::process::exit(2);
}

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    let mut kubeconfig: Option<PathBuf> = None;
    let mut context: Option<String> = None;
    let mut args = std::env::args().skip(1);
    while let Some(arg) = args.next() {
        match arg.as_str() {
            "--kubeconfig" => kubeconfig = args.next().map(PathBuf::from),
            "--context" => context = args.next(),
            _ => usage(),
        }
    }
    let (Some(kubeconfig), Some(context)) = (kubeconfig, context) else {
        usage()
    };
    let fake = FakeKube::start(FakeKubeConfig::default()).await?;
    fake.write_kubeconfig(&kubeconfig, &context)?;
    // The smoke suite opens Pods and looks for this one.
    fake.add_pod("default", "fake-pod");
    println!("listening on {}", fake.url());
    tokio::signal::ctrl_c().await?;
    fake.shutdown().await;
    Ok(())
}
