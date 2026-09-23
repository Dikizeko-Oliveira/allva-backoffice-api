export abstract class EmailTemplateRendererPortInterface {
  abstract render<TProps = unknown>(
    templateName: string,
    props: TProps,
  ): Promise<{ subject: string; html: string; text: string }>;
}
